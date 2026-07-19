/**
 * Reads a package directory or .cap archive into a validated canonical model
 * (auto-generating manifest/routes when absent).
 *
 * When security.json declares digitalSignatures (§6a), the signature is
 * verified on read against the embedded public key and the package is
 * REJECTED with typed errors (UnsignedPackageError never arises here —
 * verification only runs when declared; SignatureError on structural
 * problems, SignatureMismatchError on mismatch).
 */
import {
  assertPackageSignature,
  isPackageSigned,
  parsePackage,
  type CapsiumPackage,
  type ParsePackageOptions,
  type SignatureProvider,
} from '@capsium/core';
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { NodeSignatureProvider } from './signature-provider.js';

export interface ReadPackageOptions extends ParsePackageOptions {
  /** PEM override for signature verification (defaults to the embedded key). */
  readonly signaturePublicKeyPem?: string;
  /** Skip §6a signature verification (verification runs whenever declared). */
  readonly skipSignatureVerification?: boolean;
}

export class PackageReader {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
    private readonly signatureProvider: SignatureProvider = new NodeSignatureProvider(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  async readDirectory(dir: string, options?: ReadPackageOptions): Promise<CapsiumPackage> {
    return await this.readFiles(await this.source.load(dir), options);
  }

  async readCap(capPath: string, options?: ReadPackageOptions): Promise<CapsiumPackage> {
    return await this.readCapBytes(await this.fs.readFile(capPath), options);
  }

  async readCapBytes(bytes: Uint8Array, options?: ReadPackageOptions): Promise<CapsiumPackage> {
    return await this.readFiles(this.archive.unpack(bytes), options);
  }

  private async readFiles(
    files: ReadonlyMap<string, Uint8Array>,
    options?: ReadPackageOptions,
  ): Promise<CapsiumPackage> {
    const pkg = parsePackage(files, options);
    if (
      pkg.security !== undefined &&
      isPackageSigned(pkg.security) &&
      options?.skipSignatureVerification !== true
    ) {
      await assertPackageSignature(
        pkg.files,
        pkg.security,
        this.signatureProvider,
        options?.signaturePublicKeyPem,
      );
    }
    return pkg;
  }
}
