/**
 * Layered storage overlay semantics (ARCHITECTURE.md §5a). Isomorphic and
 * pure: resolution runs against the in-memory package file map.
 *
 * - The content/ tree is always the implicit bottom layer; configured
 *   `storage.layers` stack on top of it in declaration order (bottom →
 *   top).
 * - Each configured layer is a package-relative directory mirroring the
 *   content/ tree: layer `base` serves `base/index.html` as
 *   `content/index.html`.
 * - The merged view resolves TOP → bottom; first hit wins.
 * - Deletions are recorded as tombstones: a JSON file `.capsium-tombstones`
 *   in a layer listing content/-relative paths; a tombstoned path resolves
 *   404 even when a lower layer has it, while a file reappearing in a
 *   layer above the tombstone is served again.
 * - Paths outside content/ (e.g. dataset sources) never resolve through
 *   the layers; they address package files directly.
 * - `visibility: private` layers are not exposed to dependent packages
 *   (see `visibleLayers`).
 */
import {
  layerVisibility,
  type Storage,
  type StorageLayer,
} from './storage.js';

/** Tombstone file name inside a layer (JSON array of content/-relative paths). */
export const TOMBSTONES_FILE = '.capsium-tombstones';

/** Name of the package content directory (the implicit bottom layer). */
const CONTENT_DIR = 'content';

const CONTENT_PREFIX = `${CONTENT_DIR}/`;

/** The implicit bottom layer every package has: the content/ tree itself. */
const IMPLICIT_LAYER: StorageLayer = { path: CONTENT_DIR };

const decoder = new TextDecoder();

/**
 * Effective layers bottom → top: the implicit content/ layer plus the
 * configured storage.layers in declaration order.
 */
export function storageLayers(storage: Storage | undefined): readonly StorageLayer[] {
  return [IMPLICIT_LAYER, ...(storage?.storage.layers ?? [])];
}

/**
 * Layers visible from a given viewpoint: the package itself sees all
 * layers; dependent packages (§4a composite view) see only `exported`
 * layers.
 */
export function visibleLayers(
  storage: Storage | undefined,
  viewpoint: 'self' | 'dependent',
): readonly StorageLayer[] {
  const layers = storageLayers(storage);
  if (viewpoint === 'self') {
    return layers;
  }
  return layers.filter((layer) => layerVisibility(layer) === 'exported');
}

/**
 * Join a layer directory with a package-relative path: layers mirror the
 * content/ tree, so the content/ prefix is stripped before joining
 * (`base` + `content/x.html` → `base/x.html`); the implicit content/
 * layer maps content paths back onto themselves.
 */
export function layerFilePath(layer: StorageLayer, path: string): string {
  const relative = path.startsWith(CONTENT_PREFIX)
    ? path.slice(CONTENT_PREFIX.length)
    : path;
  return `${layer.path}/${relative}`;
}

/** Merged-view paths deleted in `layer` (empty on absent/malformed tombstones). */
export function layerTombstones(
  files: ReadonlyMap<string, Uint8Array>,
  layer: StorageLayer,
): ReadonlySet<string> {
  const bytes = files.get(layerFilePath(layer, TOMBSTONES_FILE));
  if (bytes === undefined) {
    return new Set();
  }
  try {
    const parsed: unknown = JSON.parse(decoder.decode(bytes));
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === 'string'));
  } catch {
    return new Set();
  }
}

export type LayeredResolution =
  | { readonly kind: 'found'; readonly path: string; readonly layer: StorageLayer }
  | { readonly kind: 'tombstoned' }
  | { readonly kind: 'not-found' };

/**
 * Resolve a package-relative path (e.g. `content/index.html`) against the
 * layers visible from `viewpoint`, TOP → bottom; first hit wins. A path
 * tombstoned at or above the first serving layer resolves `tombstoned`
 * (reactors answer 404) even when a lower layer has it. Paths outside
 * content/ bypass the layers and address package files directly; the
 * tombstone marker itself is never served.
 */
export function resolveLayeredPath(
  files: ReadonlyMap<string, Uint8Array>,
  storage: Storage | undefined,
  path: string,
  viewpoint: 'self' | 'dependent' = 'self',
): LayeredResolution {
  if (!path.startsWith(CONTENT_PREFIX)) {
    return files.has(path)
      ? { kind: 'found', path, layer: IMPLICIT_LAYER }
      : { kind: 'not-found' };
  }
  const relative = path.slice(CONTENT_PREFIX.length);
  if (relative === TOMBSTONES_FILE) {
    return { kind: 'not-found' };
  }
  const layers = [...visibleLayers(storage, viewpoint)].reverse(); // top → bottom
  let tombstoned = false;
  for (const layer of layers) {
    tombstoned ||= layerTombstones(files, layer).has(relative);
    const candidate = layerFilePath(layer, path);
    if (files.has(candidate)) {
      return tombstoned ? { kind: 'tombstoned' } : { kind: 'found', path: candidate, layer };
    }
  }
  return tombstoned ? { kind: 'tombstoned' } : { kind: 'not-found' };
}
