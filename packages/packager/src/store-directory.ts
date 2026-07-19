/**
 * Package store directory (ARCHITECTURE.md §4a): a directory (env
 * `CAPSIUM_STORE` or `--store DIR`) containing `<name>-<version>.cap`
 * files plus an optional `index.json` (guid → file). Dependencies
 * (guid → semver range) resolve to the newest satisfying version.
 */
import { join } from 'node:path';
import {
  parseMetadata,
  planDependencies,
  PackageConfigError,
  type CapsiumPackage,
  type StoreCandidate,
} from '@capsium/core';
import { z } from 'zod';
import { CapArchive } from './cap-archive.js';
import { NodeFileSystem, type FileSystem } from './file-system.js';
import { PackageReader } from './package-reader.js';

export const STORE_INDEX_FILE = 'index.json';

/** A .cap available in the store directory. */
export interface StoreEntry extends StoreCandidate {
  /** Absolute path of the .cap file. */
  readonly file: string;
}

const FILENAME = /^(.+)-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)\.cap$/;

const decoder = new TextDecoder();

export class StoreDirectory {
  private readonly reader: PackageReader;

  constructor(
    readonly dir: string,
    private readonly fs: FileSystem = new NodeFileSystem(),
    private readonly archive: CapArchive = new CapArchive(),
  ) {
    this.reader = new PackageReader(fs, archive);
  }

  /** Scan the store directory: every resolvable .cap with its identity. */
  async list(): Promise<StoreEntry[]> {
    const index = await this.readIndex();
    const entries: StoreEntry[] = [];
    for (const dirent of await this.fs.readdir(this.dir)) {
      if (!dirent.isFile() || !dirent.name.endsWith('.cap')) {
        continue;
      }
      const file = join(this.dir, dirent.name);
      const indexedGuid = index.get(dirent.name);
      const fromMetadata = await this.identityFromMetadata(file);
      const fromFilename = FILENAME.exec(dirent.name);
      const guid = fromMetadata?.guid ?? indexedGuid;
      const name = fromMetadata?.name ?? fromFilename?.[1];
      const version = fromMetadata?.version ?? fromFilename?.[2];
      if (guid === undefined || name === undefined || version === undefined) {
        throw new PackageConfigError(
          join(this.dir, dirent.name),
          'cannot identify package (no readable metadata.json, no index.json entry)',
        );
      }
      entries.push({ guid, name, version, file });
    }
    return entries;
  }

  /**
   * Resolve dependency ranges (guid → range) to store entries, choosing
   * the newest satisfying version per dependency. Throws
   * DependencyResolutionError when any dependency is unsatisfiable.
   */
  async resolve(dependencies: Readonly<Record<string, string>>): Promise<Map<string, StoreEntry>> {
    const entries = await this.list();
    const plan = planDependencies(dependencies, entries);
    const resolved = new Map<string, StoreEntry>();
    for (const [guid, candidate] of plan) {
      const entry = entries.find(
        (item) => item.guid === candidate.guid && item.version === candidate.version,
      );
      if (entry !== undefined) {
        resolved.set(guid, entry);
      }
    }
    return resolved;
  }

  /**
   * Resolve dependencies and read each chosen .cap into a validated model
   * (integrity/signature gates of PackageReader apply).
   */
  async loadDependencies(
    dependencies: Readonly<Record<string, string>>,
  ): Promise<Map<string, CapsiumPackage>> {
    const resolved = await this.resolve(dependencies);
    const loaded = new Map<string, CapsiumPackage>();
    for (const [guid, entry] of resolved) {
      loaded.set(guid, await this.reader.readCap(entry.file));
    }
    return loaded;
  }

  private async readIndex(): Promise<Map<string, string>> {
    let bytes: Uint8Array;
    try {
      bytes = await this.fs.readFile(join(this.dir, STORE_INDEX_FILE));
    } catch {
      return new Map();
    }
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    const index = z.record(z.string(), z.string()).parse(parsed);
    return new Map(Object.entries(index));
  }

  private async identityFromMetadata(
    file: string,
  ): Promise<{ guid: string; name: string; version: string } | undefined> {
    try {
      const files = this.archive.unpack(await this.fs.readFile(file));
      const metadataBytes = files.get('metadata.json');
      if (metadataBytes === undefined) {
        return undefined;
      }
      const metadata = parseMetadata(JSON.parse(decoder.decode(metadataBytes)));
      return { guid: metadata.guid, name: metadata.name, version: metadata.version };
    } catch {
      return undefined;
    }
  }
}
