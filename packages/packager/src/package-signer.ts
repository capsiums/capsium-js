/**
 * Signs and verifies Capsium packages with RSA-SHA256 digital signatures
 * (ARCHITECTURE.md §6a). The construction matches the Ruby gem's
 * `Capsium::Package::Signer` exactly: the signed payload is the
 * concatenation, in sorted package-relative path order, of the bytes of
 * every checksum-covered file; `signature.sig` holds the raw signature.
 *
 * Equivalent openssl verification:
 *
 *   openssl dgst -sha256 -verify signature.pub.pem -signature signature.sig payload.bin
 *
 * where payload.bin is the concatenation described above.
 */
import { join } from 'node:path';
import {
  assertPackageSignature,
  buildSecurity,
  buildSignedPayload,
  isPackageSigned,
  parseSecurity,
  withDigitalSignatures,
  PackageConfigError,
  SECURITY_FILE,
  SIGNATURE_FILE,
  SIGNATURE_PUBLIC_KEY_FILE,
  type HashProvider,
  type SignatureProvider,
} from '@capsium/core';
import { z } from 'zod';
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { NodeHashProvider } from './hash-provider.js';
import { NodeSignatureProvider } from './signature-provider.js';
import { configToBytes } from './package-writer.js';

const decoder = new TextDecoder();

export class PackageSigner {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly hashProvider: HashProvider = new NodeHashProvider(),
    private readonly signatureProvider: SignatureProvider = new NodeSignatureProvider(),
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  /**
   * Sign a package directory in place: embeds `publicKeyPem` at
   * `signature.pub.pem`, regenerates security.json (checksums plus
   * digitalSignatures) and writes the raw RSA-SHA256 signature to
   * `signature.sig`. Returns the signature file path.
   */
  async sign(dir: string, privateKeyPem: string, publicKeyPem: string): Promise<string> {
    const signed = await this.signFiles(await this.source.load(dir), privateKeyPem, publicKeyPem);
    for (const path of [SIGNATURE_PUBLIC_KEY_FILE, SECURITY_FILE, SIGNATURE_FILE]) {
      const bytes = signed.get(path);
      if (bytes !== undefined) {
        await this.fs.writeFile(join(dir, path), bytes);
      }
    }
    return join(dir, SIGNATURE_FILE);
  }

  /**
   * Sign an in-memory package file map: returns a new map with the embedded
   * public key, a regenerated security.json (checksums plus
   * digitalSignatures) and `signature.sig`.
   */
  async signFiles(
    files: ReadonlyMap<string, Uint8Array>,
    privateKeyPem: string,
    publicKeyPem: string,
  ): Promise<Map<string, Uint8Array>> {
    const out = new Map(files);
    out.set(SIGNATURE_PUBLIC_KEY_FILE, new TextEncoder().encode(publicKeyPem));
    const security = withDigitalSignatures(await buildSecurity(out, this.hashProvider));
    out.set(SECURITY_FILE, configToBytes(security));
    const signature = await this.signatureProvider.sign(
      buildSignedPayload(out, security),
      privateKeyPem,
    );
    out.set(SIGNATURE_FILE, signature);
    return out;
  }

  /** Verify the declared signature of a package directory; throws typed errors. */
  async verifyDirectory(dir: string, publicKeyPem?: string): Promise<void> {
    await this.verifyFiles(await this.source.load(dir), publicKeyPem);
  }

  /** Verify the declared signature of a .cap archive; throws typed errors. */
  async verifyCap(capPath: string, publicKeyPem?: string): Promise<void> {
    await this.verifyFiles(this.archive.unpack(await this.fs.readFile(capPath)), publicKeyPem);
  }

  /**
   * Verify the declared signature of an in-memory file map. Throws
   * UnsignedPackageError when unsigned, SignatureError on structural
   * problems and SignatureMismatchError on mismatch.
   */
  async verifyFiles(files: ReadonlyMap<string, Uint8Array>, publicKeyPem?: string): Promise<void> {
    const securityBytes = files.get(SECURITY_FILE);
    if (securityBytes === undefined) {
      throw new PackageConfigError(SECURITY_FILE, 'required package file missing');
    }
    let input: unknown;
    try {
      input = JSON.parse(decoder.decode(securityBytes));
    } catch (error) {
      throw new PackageConfigError(SECURITY_FILE, 'invalid JSON', { cause: error });
    }
    let security;
    try {
      security = parseSecurity(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new PackageConfigError(SECURITY_FILE, z.prettifyError(error), { cause: error });
      }
      throw error;
    }
    await assertPackageSignature(files, security, this.signatureProvider, publicKeyPem);
  }

  /** True when the file map's security.json declares digitalSignatures. */
  static isSigned(files: ReadonlyMap<string, Uint8Array>): boolean {
    const securityBytes = files.get(SECURITY_FILE);
    if (securityBytes === undefined) {
      return false;
    }
    try {
      return isPackageSigned(parseSecurity(JSON.parse(decoder.decode(securityBytes))));
    } catch {
      return false;
    }
  }
}
