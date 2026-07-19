import { execFileSync, execSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSignedPayload,
  parseSecurity,
  SIGNATURE_FILE,
  SIGNATURE_PUBLIC_KEY_FILE,
  SignatureError,
  SignatureMismatchError,
  verifyPackageSignature,
} from '@capsium/core';
import {
  CapArchive,
  DirectoryPackageSource,
  NodeSignatureProvider,
  PackageReader,
  PackageSigner,
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
  name: 'signed-demo',
  version: '1.0.0',
  description: 'Signature fixture package',
  guid: 'https://example.com/signed-demo',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

const fixtureFiles: Record<string, string> = {
  'metadata.json': JSON.stringify(metadata),
  'content/index.html': '<!doctype html><h1>Signed</h1>',
  'content/styles.css': 'body { color: black; }',
};

const { privateKey: privateKeyPem, publicKey: publicKeyPem } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const signer = new PackageSigner();
const reader = new PackageReader();
const archive = new CapArchive();

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capsium-sign-'));
  for (const [path, content] of Object.entries(fixtureFiles)) {
    const full = join(dir, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function signFreshDir(): Promise<string> {
  const fresh = await mkdtemp(join(tmpdir(), 'capsium-sign-fresh-'));
  for (const [path, content] of Object.entries(fixtureFiles)) {
    const full = join(fresh, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  await signer.sign(fresh, privateKeyPem, publicKeyPem);
  return fresh;
}

describe('PackageSigner.sign', () => {
  it('writes signature.pub.pem, signature.sig and digitalSignatures in security.json', async () => {
    const signed = await signFreshDir();
    try {
      const security = JSON.parse(await readFile(join(signed, 'security.json'), 'utf8'));
      expect(security.security.digitalSignatures).toEqual({
        publicKey: SIGNATURE_PUBLIC_KEY_FILE,
        signatureFile: SIGNATURE_FILE,
      });
      const embedded = await readFile(join(signed, SIGNATURE_PUBLIC_KEY_FILE), 'utf8');
      expect(embedded).toBe(publicKeyPem);
      const signature = await readFile(join(signed, SIGNATURE_FILE));
      expect(signature.byteLength).toBe(256); // 2048-bit RSA raw signature
      // The signature file itself must not be checksum-covered (Ruby parity).
      expect(security.security.integrityChecks.checksums[SIGNATURE_FILE]).toBeUndefined();
      expect(
        security.security.integrityChecks.checksums[SIGNATURE_PUBLIC_KEY_FILE],
      ).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await rm(signed, { recursive: true, force: true });
    }
  });

  it('rejects RSA keys shorter than 2048 bits', async () => {
    const weak = generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    await expect(signer.sign(dir, weak.privateKey, weak.publicKey)).rejects.toThrow(SignatureError);
  });
});

describe('PackageSigner.verify + PackageReader (verify on read)', () => {
  it('verifies a freshly signed directory and .cap', async () => {
    const signed = await signFreshDir();
    try {
      await expect(signer.verifyDirectory(signed)).resolves.toBeUndefined();
      await expect(reader.readDirectory(signed)).resolves.toMatchObject({
        metadata: { name: 'signed-demo' },
      });
    } finally {
      await rm(signed, { recursive: true, force: true });
    }
  });

  it('rejects a tampered signed package on read with SignatureMismatchError', async () => {
    const signed = await signFreshDir();
    try {
      await writeFile(join(signed, 'content', 'index.html'), '<h1>tampered</h1>');
      await expect(signer.verifyDirectory(signed)).rejects.toThrow(SignatureMismatchError);
      await expect(reader.readDirectory(signed)).rejects.toThrow(SignatureMismatchError);
    } finally {
      await rm(signed, { recursive: true, force: true });
    }
  });

  it('rejects a signed package when a checksum-covered file is removed', async () => {
    const signed = await signFreshDir();
    try {
      await rm(join(signed, 'content', 'styles.css'));
      await expect(reader.readDirectory(signed)).rejects.toThrow(SignatureError);
    } finally {
      await rm(signed, { recursive: true, force: true });
    }
  });

  it('reads unsigned packages without signature checks', async () => {
    const model = await reader.readDirectory(dir);
    expect(model.metadata.name).toBe('signed-demo');
  });
});

describe('openssl interop (Ruby gem construction parity)', () => {
  it.skipIf(!hasOpenssl)(
    'openssl dgst -sha256 -verify accepts a signature produced by this implementation',
    async () => {
      const signed = await signFreshDir();
      try {
        // Reconstruct the §6a signed payload and ask openssl to verify.
        const files = await new DirectoryPackageSource().load(signed);
        const security = parseSecurity(
          JSON.parse(await readFile(join(signed, 'security.json'), 'utf8')),
        );
        const payload = buildSignedPayload(files, security);
        const payloadPath = join(signed, 'payload.bin');
        await writeFile(payloadPath, payload);
        const out = execFileSync('openssl', [
          'dgst',
          '-sha256',
          '-verify',
          join(signed, SIGNATURE_PUBLIC_KEY_FILE),
          '-signature',
          join(signed, SIGNATURE_FILE),
          payloadPath,
        ]);
        expect(out.toString()).toContain('Verified OK');
      } finally {
        await rm(signed, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasOpenssl)(
    'a signature produced by openssl dgst -sha256 -sign verifies here',
    async () => {
      const signed = await signFreshDir();
      try {
        const keyPath = join(signed, 'key.pem');
        await writeFile(keyPath, privateKeyPem);
        const files = await new DirectoryPackageSource().load(signed);
        const security = parseSecurity(
          JSON.parse(await readFile(join(signed, 'security.json'), 'utf8')),
        );
        const payloadPath = join(signed, 'payload.bin');
        const opensslSigPath = join(signed, 'openssl.sig');
        await writeFile(payloadPath, buildSignedPayload(files, security));
        execFileSync('openssl', [
          'dgst',
          '-sha256',
          '-sign',
          keyPath,
          '-out',
          opensslSigPath,
          payloadPath,
        ]);
        const opensslSig = new Uint8Array(await readFile(opensslSigPath));
        const provider = new NodeSignatureProvider();
        await expect(
          provider.verify(buildSignedPayload(files, security), opensslSig, publicKeyPem),
        ).resolves.toBe(true);
        // And through the full package-level path with the openssl signature swapped in.
        files.set(SIGNATURE_FILE, opensslSig);
        await expect(verifyPackageSignature(files, security, provider)).resolves.toBe(true);
      } finally {
        await rm(signed, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(!hasOpenssl)('verifies against an embedded X.509 certificate', async () => {
    const signed = await signFreshDir();
    try {
      const keyPath = join(signed, 'key.pem');
      const certPath = join(signed, 'cert.pem');
      await writeFile(keyPath, privateKeyPem);
      execFileSync('openssl', [
        'req',
        '-x509',
        '-new',
        '-key',
        keyPath,
        '-subj',
        '/CN=capsium-test',
        '-days',
        '1',
        '-out',
        certPath,
      ]);
      const certPem = await readFile(certPath, 'utf8');
      // Sign with the certificate embedded as the public key material.
      await signer.sign(signed, privateKeyPem, certPem);
      await expect(signer.verifyDirectory(signed)).resolves.toBeUndefined();
      await expect(reader.readDirectory(signed)).resolves.toBeDefined();
    } finally {
      await rm(signed, { recursive: true, force: true });
    }
  });
});

describe('PackageSigner.signFiles', () => {
  it('produces a signed file map that verifies after zip round-trip', async () => {
    const files = new Map(
      Object.entries(fixtureFiles).map(([path, content]) => [
        path,
        new TextEncoder().encode(content),
      ]),
    );
    const signed = await signer.signFiles(files, privateKeyPem, publicKeyPem);
    const capBytes = archive.pack(signed);
    const model = await reader.readCapBytes(capBytes);
    expect(model.metadata.name).toBe('signed-demo');
    await expect(signer.verifyFiles(archive.unpack(capBytes))).resolves.toBeUndefined();
  });
});
