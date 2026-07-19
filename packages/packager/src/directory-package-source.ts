/**
 * Loads/saves a package directory as an in-memory file map keyed by
 * package-relative POSIX path.
 */
import { dirname, join, relative, sep } from 'node:path';
import { NodeFileSystem, type FileSystem } from './file-system.js';

export class DirectoryPackageSource {
  constructor(private readonly fs: FileSystem = new NodeFileSystem()) {}

  async load(dir: string): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    await this.walk(dir, dir, files);
    return files;
  }

  private async walk(root: string, dir: string, files: Map<string, Uint8Array>): Promise<void> {
    for (const entry of await this.fs.readdir(dir)) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(root, full, files);
      } else if (entry.isFile()) {
        const path = relative(root, full).split(sep).join('/');
        files.set(path, await this.fs.readFile(full));
      }
    }
  }

  async save(dir: string, files: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const path of paths) {
      const bytes = files.get(path);
      if (bytes === undefined) {
        continue;
      }
      const full = join(dir, ...path.split('/'));
      await this.fs.mkdir(dirname(full), { recursive: true });
      await this.fs.writeFile(full, bytes);
    }
  }
}
