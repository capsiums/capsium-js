/**
 * Minimal fs abstraction, dependency-injected into the IO classes so tests
 * can substitute fakes. `NodeFileSystem` adapts node:fs/promises.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';

export interface DirentLike {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface FileSystem {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  readdir(path: string): Promise<DirentLike[]>;
}

export class NodeFileSystem implements FileSystem {
  async readFile(path: string): Promise<Uint8Array> {
    return await readFile(path);
  }

  async writeFile(path: string, data: Uint8Array): Promise<void> {
    await writeFile(path, data);
  }

  async mkdir(path: string, options: { recursive: true }): Promise<unknown> {
    return await mkdir(path, options);
  }

  async readdir(path: string): Promise<DirentLike[]> {
    return await readdir(path, { withFileTypes: true });
  }
}
