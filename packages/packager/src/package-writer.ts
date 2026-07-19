/**
 * Writes .cap packages: validates the model, auto-generates missing
 * manifest.json/routes.json (§1: generated at pack time when absent),
 * computes SHA-256 checksums into security.json, and zips deterministically.
 */
import { join } from 'node:path';
import {
  buildSecurity,
  parsePackage,
  MANIFEST_FILE,
  ROUTES_FILE,
  SECURITY_FILE,
  type HashProvider,
} from '@capsium/core';
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { NodeHashProvider } from './hash-provider.js';

/** Canonical JSON serialization for generated config files. */
export function configToBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}

export class PackageWriter {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly hashProvider: HashProvider = new NodeHashProvider(),
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  /**
   * Pack an in-memory file map into .cap bytes. Hand-authored
   * manifest.json/routes.json are preserved; missing ones are generated.
   * security.json is always (re)generated.
   */
  async packFiles(files: ReadonlyMap<string, Uint8Array>): Promise<Uint8Array> {
    const pkg = parsePackage(files);
    const out = new Map(files);
    if (!out.has(MANIFEST_FILE)) {
      out.set(MANIFEST_FILE, configToBytes(pkg.manifest));
    }
    if (!out.has(ROUTES_FILE)) {
      out.set(ROUTES_FILE, configToBytes(pkg.routes));
    }
    const security = await buildSecurity(out, this.hashProvider);
    out.set(SECURITY_FILE, configToBytes(security));
    return this.archive.pack(out);
  }

  async packDirectory(dir: string): Promise<Uint8Array> {
    return await this.packFiles(await this.source.load(dir));
  }

  async writeCap(dir: string, outPath: string): Promise<void> {
    await this.fs.writeFile(outPath, await this.packDirectory(dir));
  }

  /** Compute SHA-256 checksums and write security.json into a package directory. */
  async writeSecurityFile(dir: string): Promise<void> {
    const files = await this.source.load(dir);
    const security = await buildSecurity(files, this.hashProvider);
    await this.fs.writeFile(join(dir, SECURITY_FILE), configToBytes(security));
  }
}
