/**
 * Reads a package directory or .cap archive into a validated canonical model
 * (auto-generating manifest/routes when absent).
 */
import { parsePackage, type CapsiumPackage, type ParsePackageOptions } from '@capsium/core';
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';

export class PackageReader {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  async readDirectory(dir: string, options?: ParsePackageOptions): Promise<CapsiumPackage> {
    return parsePackage(await this.source.load(dir), options);
  }

  async readCap(capPath: string, options?: ParsePackageOptions): Promise<CapsiumPackage> {
    return this.readCapBytes(await this.fs.readFile(capPath), options);
  }

  readCapBytes(bytes: Uint8Array, options?: ParsePackageOptions): CapsiumPackage {
    return parsePackage(this.archive.unpack(bytes), options);
  }
}
