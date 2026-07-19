/**
 * Extracts .cap archives to a package directory.
 */
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';

export class PackageExtractor {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  async extract(capPath: string, destDir: string): Promise<void> {
    await this.extractBytes(await this.fs.readFile(capPath), destDir);
  }

  async extractBytes(bytes: Uint8Array, destDir: string): Promise<void> {
    await this.source.save(destDir, this.archive.unpack(bytes));
  }
}
