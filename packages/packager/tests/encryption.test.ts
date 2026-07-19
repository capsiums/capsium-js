import { execFileSync, execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  isEncryptedPackage,
  parseEncryptionEnvelope,
  ENCRYPTED_PACKAGE_FILE,
  ENCRYPTION_ENVELOPE_FILE,
  METADATA_FILE,
} from '@capsium/core';
import {
  CapArchive,
  DecryptionError,
  EncryptedPackageError,
  PackageCipher,
  PackageReader,
  PackageWriter,
} from '../src/index.js';

const hasOpenssl = (() => {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const metadata = {
  name: 'encrypted-demo',
  version: '1.0.0',
  description: 'Encryption fixture package',
  guid: 'https://example.com/encrypted-demo',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

const fixtureFiles: Record<string, string> = {
  'metadata.json': JSON.stringify(metadata),
  'content/index.html': '<!doctype html><h1>Secret</h1>',
  'data/secret.json': JSON.stringify({ classification: 'top-secret' }),
};

const recipient = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const other = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const cipher = new PackageCipher();
const writer = new PackageWriter();
const reader = new PackageReader();
const archive = new CapArchive();

let dir: string;
let capBytes: Uint8Array;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capsium-encrypt-'));
  for (const [path, content] of Object.entries(fixtureFiles)) {
    const full = join(dir, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  capBytes = await writer.packDirectory(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PackageCipher.encrypt (§6b layout)', () => {
  it('produces metadata.json + signature.json + package.enc, metadata cleartext', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    const files = archive.unpack(encBytes);
    expect([...files.keys()].sort()).toEqual([
      METADATA_FILE,
      ENCRYPTED_PACKAGE_FILE,
      ENCRYPTION_ENVELOPE_FILE,
    ]);
    expect(isEncryptedPackage(files)).toBe(true);
    // metadata.json stays cleartext for identification.
    expect(JSON.parse(new TextDecoder().decode(files.get(METADATA_FILE)))).toEqual(metadata);
    const envelope = parseEncryptionEnvelope(
      JSON.parse(new TextDecoder().decode(files.get(ENCRYPTION_ENVELOPE_FILE))),
    );
    expect(envelope.encryption.algorithm).toBe('AES-256-GCM');
    expect(envelope.encryption.keyManagement).toBe('RSA-OAEP-SHA256');
    expect(base64ToBytes(envelope.encryption.iv).byteLength).toBe(12);
    expect(base64ToBytes(envelope.encryption.authTag).byteLength).toBe(16);
    expect(base64ToBytes(envelope.encryption.encryptedDek).byteLength).toBe(256);
  });

  it('encrypts a package directory end-to-end (packs first)', async () => {
    const outPath = join(dir, 'package.encrypted.cap');
    await cipher.encrypt(dir, recipient.publicKey, outPath);
    const encBytes = new Uint8Array(await readFile(outPath));
    expect(isEncryptedPackage(archive.unpack(encBytes))).toBe(true);
  });
});

describe('PackageCipher.decrypt', () => {
  it('round-trips byte-identical .cap bytes', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    const plainBytes = await cipher.decryptBytes(encBytes, recipient.privateKey);
    expect(plainBytes).toEqual(capBytes);
  });

  it('decrypts a file to outPath', async () => {
    const encPath = join(dir, 'roundtrip.enc.cap');
    const outPath = join(dir, 'roundtrip.plain.cap');
    await writeFile(encPath, await cipher.encryptBytes(capBytes, recipient.publicKey));
    await cipher.decrypt(encPath, recipient.privateKey, outPath);
    expect(new Uint8Array(await readFile(outPath))).toEqual(capBytes);
  });

  it('fails with a typed error for the wrong private key', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    await expect(cipher.decryptBytes(encBytes, other.privateKey)).rejects.toThrow(DecryptionError);
  });

  it('fails with a typed error for a tampered ciphertext', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    const files = archive.unpack(encBytes);
    const ciphertext = new Uint8Array(files.get(ENCRYPTED_PACKAGE_FILE)!);
    ciphertext[0] = (ciphertext[0] ?? 0) ^ 0xff;
    files.set(ENCRYPTED_PACKAGE_FILE, ciphertext);
    await expect(
      cipher.decryptBytes(archive.pack(files), recipient.privateKey),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('PackageReader transparent decryption', () => {
  it('reads an encrypted package when given the key', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    const model = await reader.readCapBytes(encBytes, { decryptionKeyPem: recipient.privateKey });
    expect(model.metadata).toEqual(metadata);
    expect(model.files.has('data/secret.json')).toBe(true);
  });

  it('rejects an encrypted package without a key', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    await expect(reader.readCapBytes(encBytes)).rejects.toThrow(EncryptedPackageError);
  });

  it('rejects with DecryptionError for the wrong key', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    await expect(
      reader.readCapBytes(encBytes, { decryptionKeyPem: other.privateKey }),
    ).rejects.toThrow(DecryptionError);
  });
});

describe('openssl interop (DEK wrap)', () => {
  // Ruby has no encryption support yet, so there is no Ruby fixture; the
  // RSA-OAEP-SHA256 wrap is verified against openssl pkeyutl instead (the
  // same OpenSSL EVP primitives Ruby's OpenSSL bindings would use).
  it.skipIf(!hasOpenssl)('openssl pkeyutl unwraps a DEK wrapped by this implementation', async () => {
    const encBytes = await cipher.encryptBytes(capBytes, recipient.publicKey);
    const files = archive.unpack(encBytes);
    const envelope = parseEncryptionEnvelope(
      JSON.parse(new TextDecoder().decode(files.get(ENCRYPTION_ENVELOPE_FILE))),
    );
    const work = await mkdtemp(join(tmpdir(), 'capsium-unwrap-'));
    try {
      const keyPath = join(work, 'key.pem');
      const dekPath = join(work, 'dek.bin');
      const wrappedPath = join(work, 'dek.wrapped');
      await writeFile(keyPath, recipient.privateKey);
      await writeFile(wrappedPath, base64ToBytes(envelope.encryption.encryptedDek));
      execFileSync('openssl', [
        'pkeyutl',
        '-decrypt',
        '-inkey',
        keyPath,
        '-in',
        wrappedPath,
        '-out',
        dekPath,
        '-pkeyopt',
        'rsa_padding_mode:oaep',
        '-pkeyopt',
        'rsa_oaep_md:sha256',
        '-pkeyopt',
        'rsa_mgf1_md:sha256',
      ]);
      expect((await readFile(dekPath)).byteLength).toBe(32);
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  });

  it.skipIf(!hasOpenssl)(
    'decrypts a package whose DEK was wrapped by openssl pkeyutl',
    async () => {
      const work = await mkdtemp(join(tmpdir(), 'capsium-wrap-'));
      try {
        const pubPath = join(work, 'pub.pem');
        const dekPath = join(work, 'dek.bin');
        const wrappedPath = join(work, 'dek.wrapped');
        const dek = new Uint8Array(32).map((_, i) => i);
        await writeFile(pubPath, recipient.publicKey);
        await writeFile(dekPath, dek);
        execFileSync('openssl', [
          'pkeyutl',
          '-encrypt',
          '-pubin',
          '-inkey',
          pubPath,
          '-in',
          dekPath,
          '-out',
          wrappedPath,
          '-pkeyopt',
          'rsa_padding_mode:oaep',
          '-pkeyopt',
          'rsa_oaep_md:sha256',
          '-pkeyopt',
          'rsa_mgf1_md:sha256',
        ]);
        // Build the §6b envelope around the openssl-wrapped DEK (AES-256-GCM
        // encryption itself via node:crypto).
        const { createCipheriv } = await import('node:crypto');
        const iv = new Uint8Array(12).map((_, i) => 255 - i);
        const gcm = createCipheriv('aes-256-gcm', dek, iv);
        const ciphertext = new Uint8Array(Buffer.concat([gcm.update(capBytes), gcm.final()]));
        const envelope = {
          encryption: {
            algorithm: 'AES-256-GCM',
            keyManagement: 'RSA-OAEP-SHA256',
            encryptedDek: Buffer.from(await readFile(wrappedPath)).toString('base64'),
            iv: Buffer.from(iv).toString('base64'),
            authTag: Buffer.from(gcm.getAuthTag()).toString('base64'),
          },
        };
        const encBytes = archive.pack(
          new Map<string, Uint8Array>([
            [METADATA_FILE, new TextEncoder().encode(JSON.stringify(metadata))],
            [ENCRYPTION_ENVELOPE_FILE, new TextEncoder().encode(JSON.stringify(envelope))],
            [ENCRYPTED_PACKAGE_FILE, ciphertext],
          ]),
        );
        await expect(cipher.decryptBytes(encBytes, recipient.privateKey)).resolves.toEqual(
          capBytes,
        );
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    },
  );
});
