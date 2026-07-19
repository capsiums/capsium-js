/**
 * Verifies package integrity: recomputes SHA-256 checksums and compares
 * against security.json, returning a typed issue list (never throws on
 * mismatch — a mismatch is data, not an exception).
 */
import { z } from 'zod';
import {
  verifyIntegrity,
  parseSecurity,
  PackageConfigError,
  SECURITY_FILE,
  type HashProvider,
  type IntegrityReport,
} from '@capsium/core';
import { CapArchive } from './cap-archive.js';
import { DirectoryPackageSource } from './directory-package-source.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { NodeHashProvider } from './hash-provider.js';

const decoder = new TextDecoder();

export class IntegrityVerifier {
  private readonly source: DirectoryPackageSource;

  constructor(
    private readonly hashProvider: HashProvider = new NodeHashProvider(),
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.source = new DirectoryPackageSource(fs);
  }

  async verifyFiles(files: ReadonlyMap<string, Uint8Array>): Promise<IntegrityReport> {
    const securityBytes = files.get(SECURITY_FILE);
    if (securityBytes === undefined) {
      return await verifyIntegrity(files, undefined, this.hashProvider);
    }
    let input: unknown;
    try {
      input = JSON.parse(decoder.decode(securityBytes));
    } catch (error) {
      throw new PackageConfigError(SECURITY_FILE, 'invalid JSON', { cause: error });
    }
    try {
      return await verifyIntegrity(files, parseSecurity(input), this.hashProvider);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new PackageConfigError(SECURITY_FILE, z.prettifyError(error), { cause: error });
      }
      throw error;
    }
  }

  async verifyDirectory(dir: string): Promise<IntegrityReport> {
    return await this.verifyFiles(await this.source.load(dir));
  }

  async verifyCap(capPath: string): Promise<IntegrityReport> {
    return await this.verifyBytes(await this.fs.readFile(capPath));
  }

  async verifyBytes(bytes: Uint8Array): Promise<IntegrityReport> {
    return await this.verifyFiles(this.archive.unpack(bytes));
  }
}
