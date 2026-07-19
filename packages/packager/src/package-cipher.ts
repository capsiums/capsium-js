/**
 * Package encryption (ARCHITECTURE.md §6b): AES-256-GCM for the inner zip
 * with the 32-byte DEK wrapped by the recipient's RSA public key
 * (RSA-OAEP-SHA256, MGF1-SHA256). The encrypted .cap is a zip of
 * `metadata.json` (cleartext), `signature.json` (cleartext envelope) and
 * `package.enc` (ciphertext). OpenPGP is out of scope.
 */
import {
  createCipheriv,
  createDecipheriv,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  constants,
} from 'node:crypto';
import { stat } from 'node:fs/promises';
import {
  base64ToBytes,
  bytesToBase64,
  parseEncryptionEnvelope,
  CapsiumError,
  MissingPackageFileError,
  PackageConfigError,
  DEK_BYTES,
  ENCRYPTED_PACKAGE_FILE,
  ENCRYPTION_ENVELOPE_FILE,
  GCM_AUTH_TAG_BYTES,
  GCM_IV_BYTES,
  METADATA_FILE,
  type EncryptionEnvelope,
} from '@capsium/core';
import { z } from 'zod';
import { CapArchive } from './cap-archive.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { NodeHashProvider } from './hash-provider.js';
import { PackageWriter, configToBytes } from './package-writer.js';

/** Encryption failed (bad key material, unreadable input, ...). */
export class EncryptionError extends CapsiumError {}

/** Decryption failed: wrong key, corrupted envelope or ciphertext. */
export class DecryptionError extends CapsiumError {}

/** A package is encrypted but no decryption key was supplied. */
export class EncryptedPackageError extends DecryptionError {
  constructor() {
    super('package is encrypted (§6b); supply a decryption key');
  }
}

const decoder = new TextDecoder();

function wrapDek(dek: Uint8Array, publicKeyPem: string): Uint8Array {
  try {
    return publicEncrypt(
      { key: publicKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      dek,
    );
  } catch (error) {
    throw new EncryptionError('cannot wrap the DEK with the given public key', { cause: error });
  }
}

function unwrapDek(encryptedDek: Uint8Array, privateKeyPem: string): Uint8Array {
  try {
    return privateDecrypt(
      { key: privateKeyPem, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
      encryptedDek,
    );
  } catch (error) {
    throw new DecryptionError('cannot unwrap the DEK (wrong private key?)', { cause: error });
  }
}

export class PackageCipher {
  constructor(
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
    private readonly random: (bytes: number) => Uint8Array = randomBytes,
  ) {}

  /**
   * Encrypt a package into the §6b envelope: `packagePath` may be a package
   * directory (packed first, so checksums are in place) or a `.cap` file.
   * Writes the encrypted .cap to `outPath`.
   */
  async encrypt(packagePath: string, publicKeyPem: string, outPath: string): Promise<void> {
    await this.fs.writeFile(outPath, await this.encryptCap(packagePath, publicKeyPem));
  }

  /** Encrypt a directory or .cap into encrypted .cap bytes (§6b). */
  async encryptCap(packagePath: string, publicKeyPem: string): Promise<Uint8Array> {
    const capBytes = (await stat(packagePath)).isDirectory()
      ? await new PackageWriter(new NodeHashProvider(), this.fs, this.archive).packDirectory(
          packagePath,
        )
      : await this.fs.readFile(packagePath);
    return await this.encryptBytes(capBytes, publicKeyPem);
  }

  /** Encrypt .cap bytes into the §6b envelope layout (as zip bytes). */
  async encryptBytes(capBytes: Uint8Array, publicKeyPem: string): Promise<Uint8Array> {
    const inner = this.archive.unpack(capBytes);
    const metadata = inner.get(METADATA_FILE);
    if (metadata === undefined) {
      throw new MissingPackageFileError(METADATA_FILE);
    }
    const dek = this.random(DEK_BYTES);
    const iv = this.random(GCM_IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const ciphertext = new Uint8Array(
      Buffer.concat([cipher.update(capBytes), cipher.final()]),
    );
    const envelope: EncryptionEnvelope = {
      encryption: {
        algorithm: 'AES-256-GCM',
        keyManagement: 'RSA-OAEP-SHA256',
        encryptedDek: bytesToBase64(wrapDek(dek, publicKeyPem)),
        iv: bytesToBase64(iv),
        authTag: bytesToBase64(cipher.getAuthTag()),
      },
    };
    return this.archive.pack(
      new Map([
        [METADATA_FILE, metadata],
        [ENCRYPTION_ENVELOPE_FILE, configToBytes(envelope)],
        [ENCRYPTED_PACKAGE_FILE, ciphertext],
      ]),
    );
  }

  /** Decrypt an encrypted .cap file, writing the inner .cap to `outPath`. */
  async decrypt(capPath: string, privateKeyPem: string, outPath: string): Promise<void> {
    await this.fs.writeFile(outPath, await this.decryptBytes(await this.fs.readFile(capPath), privateKeyPem));
  }

  /** Decrypt encrypted .cap bytes into the inner .cap bytes. */
  async decryptBytes(encBytes: Uint8Array, privateKeyPem: string): Promise<Uint8Array> {
    return await this.decryptFiles(this.archive.unpack(encBytes), privateKeyPem);
  }

  /** Decrypt an unpacked §6b envelope file map into the inner .cap bytes. */
  async decryptFiles(
    files: ReadonlyMap<string, Uint8Array>,
    privateKeyPem: string,
  ): Promise<Uint8Array> {
    const ciphertext = files.get(ENCRYPTED_PACKAGE_FILE);
    if (ciphertext === undefined) {
      throw new DecryptionError(`encrypted package is missing ${ENCRYPTED_PACKAGE_FILE}`);
    }
    const envelope = this.parseEnvelope(files);
    const { encryptedDek, iv, authTag } = envelope.encryption;
    const ivBytes = base64ToBytes(iv);
    const tagBytes = base64ToBytes(authTag);
    if (ivBytes.byteLength !== GCM_IV_BYTES) {
      throw new DecryptionError(`GCM IV must be ${GCM_IV_BYTES} bytes, got ${ivBytes.byteLength}`);
    }
    if (tagBytes.byteLength !== GCM_AUTH_TAG_BYTES) {
      throw new DecryptionError(
        `GCM auth tag must be ${GCM_AUTH_TAG_BYTES} bytes, got ${tagBytes.byteLength}`,
      );
    }
    const dek = unwrapDek(base64ToBytes(encryptedDek), privateKeyPem);
    const decipher = createDecipheriv('aes-256-gcm', dek, ivBytes);
    decipher.setAuthTag(tagBytes);
    try {
      return new Uint8Array(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]),
      );
    } catch (error) {
      throw new DecryptionError(
        'AES-256-GCM authentication failed (ciphertext or key is wrong)',
        { cause: error },
      );
    }
  }

  private parseEnvelope(files: ReadonlyMap<string, Uint8Array>): EncryptionEnvelope {
    const envelopeBytes = files.get(ENCRYPTION_ENVELOPE_FILE);
    if (envelopeBytes === undefined) {
      throw new DecryptionError(`encrypted package is missing ${ENCRYPTION_ENVELOPE_FILE}`);
    }
    let input: unknown;
    try {
      input = JSON.parse(decoder.decode(envelopeBytes));
    } catch (error) {
      throw new PackageConfigError(ENCRYPTION_ENVELOPE_FILE, 'invalid JSON', { cause: error });
    }
    try {
      return parseEncryptionEnvelope(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new PackageConfigError(ENCRYPTION_ENVELOPE_FILE, z.prettifyError(error), {
          cause: error,
        });
      }
      throw error;
    }
  }
}

