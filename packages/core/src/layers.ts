/**
 * Layered storage overlay semantics (ARCHITECTURE.md §5a). Isomorphic and
 * pure: resolution runs against the in-memory package file map.
 *
 * - Each layer is a package-relative directory mirroring the package tree
 *   (e.g. layer `base` serves `base/content/index.html` as
 *   `content/index.html`).
 * - The merged view resolves TOP → bottom; first hit wins. A package
 *   without a `layers` config behaves as a single implicit layer (the
 *   package root).
 * - Deletions are recorded as tombstones: a JSON file
 *   `.capsium-tombstones` in a layer listing merged-view paths; tombstoned
 *   paths resolve 404 even if a lower layer has them.
 * - `visibility: private` layers are not exposed to dependent packages
 *   (see `visibleLayers`).
 */
import {
  layerVisibility,
  type Storage,
  type StorageLayer,
} from './storage.js';

/** Tombstone file name inside a layer (JSON array of merged-view paths). */
export const TOMBSTONES_FILE = '.capsium-tombstones';

/** The implicit layer for packages without a `layers` config: the package root. */
const IMPLICIT_LAYER: StorageLayer = { path: '' };

const decoder = new TextDecoder();

/** Effective layers bottom → top (the implicit root layer when unconfigured). */
export function storageLayers(storage: Storage | undefined): readonly StorageLayer[] {
  const layers = storage?.storage.layers;
  return layers !== undefined && layers.length > 0 ? layers : [IMPLICIT_LAYER];
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

/** Join a layer directory with a merged-view path. */
export function layerFilePath(layer: StorageLayer, path: string): string {
  return layer.path === '' ? path : `${layer.path}/${path}`;
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
 * Resolve a merged-view path (e.g. `content/index.html`) against the
 * layers visible from `viewpoint`, TOP → bottom; first hit wins. A path
 * tombstoned at or above the first serving layer resolves `tombstoned`
 * (reactors answer 404) even when a lower layer has it.
 */
export function resolveLayeredPath(
  files: ReadonlyMap<string, Uint8Array>,
  storage: Storage | undefined,
  path: string,
  viewpoint: 'self' | 'dependent' = 'self',
): LayeredResolution {
  const layers = [...visibleLayers(storage, viewpoint)].reverse(); // top → bottom
  const tombstoned = new Set<string>();
  for (const layer of layers) {
    for (const deleted of layerTombstones(files, layer)) {
      tombstoned.add(deleted);
    }
    const candidate = layerFilePath(layer, path);
    if (files.has(candidate)) {
      return { kind: 'found', path: candidate, layer };
    }
    if (tombstoned.has(path)) {
      return { kind: 'tombstoned' };
    }
  }
  return { kind: 'not-found' };
}
