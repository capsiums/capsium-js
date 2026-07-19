/**
 * .cap archive codec (ZIP, MIME application/vnd.capsium.package) via fflate.
 * Packing is deterministic (sorted entries).
 */
import { unzipSync, zipSync } from 'fflate';
import { CapsiumError } from '@capsium/core';

export class CapArchiveError extends CapsiumError {}

function isSafePath(path: string): boolean {
  return !path.startsWith('/') && !path.split('/').some((segment) => segment === '..');
}

export class CapArchive {
  pack(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
    const entries: Record<string, Uint8Array> = {};
    const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const path of paths) {
      if (!isSafePath(path)) {
        throw new CapArchiveError(`unsafe package path: ${path}`);
      }
      const bytes = files.get(path);
      if (bytes !== undefined) {
        entries[path] = bytes;
      }
    }
    return zipSync(entries);
  }

  unpack(bytes: Uint8Array): Map<string, Uint8Array> {
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(bytes);
    } catch (error) {
      throw new CapArchiveError('invalid .cap archive (not a zip)', { cause: error });
    }
    const files = new Map<string, Uint8Array>();
    for (const [path, data] of Object.entries(unzipped)) {
      if (path.endsWith('/')) {
        continue; // directory entry
      }
      if (!isSafePath(path)) {
        throw new CapArchiveError(`unsafe path in archive: ${path}`);
      }
      files.set(path, data);
    }
    return files;
  }
}
