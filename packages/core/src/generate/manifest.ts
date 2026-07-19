/**
 * manifest.json auto-generation (ARCHITECTURE.md §3).
 *
 * Scans the given file list (package-relative POSIX paths with a MIME type
 * per file) and produces the canonical manifest. Only `content/` resources
 * are inventoried; resources are `exported` by default; keys are sorted for
 * deterministic output.
 */
import type { Manifest } from '../manifest.js';

export const CONTENT_DIR = 'content/';

/**
 * Build a manifest from `files` (path -> MIME type). Files outside
 * `content/` are ignored: the manifest inventories served content only.
 */
export function buildManifest(files: ReadonlyMap<string, string>): Manifest {
  const paths = [...files.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const resources: Record<string, { type: string; visibility: 'exported' }> = {};
  for (const path of paths) {
    if (!path.startsWith(CONTENT_DIR)) {
      continue;
    }
    const type = files.get(path);
    if (type === undefined) {
      continue;
    }
    resources[path] = { type, visibility: 'exported' };
  }
  return { resources };
}
