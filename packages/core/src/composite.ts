/**
 * Composite package helpers (ARCHITECTURE.md §4a): dependency resolution
 * against a package store, dependency resource references and
 * exported-visibility enforcement. Isomorphic.
 *
 * Dependency resource references are `<dependency-guid>/<package-relative
 * path>`: any reference containing `://` whose longest matching prefix is
 * a declared dependency guid addresses that dependency's content — e.g.
 * with dependency guid `capsium://example.com/core`, the reference
 * `capsium://example.com/core/content/app.js` addresses
 * `content/app.js` of that dependency, and with guid
 * `https://example.com/core` the reference is
 * `https://example.com/core/content/app.js` (the Ruby reactor matches the
 * same way). When several dependency guids prefix-match, the longest guid
 * wins.
 */
import { CapsiumError } from './errors.js';
import { resolveLayeredPath } from './layers.js';
import { resourceVisibility } from './manifest.js';
import { newestSatisfying } from './semver.js';
import type { CapsiumPackage } from './package.js';

export const CAPSIUM_SCHEME = 'capsium://';

/** A dependency could not be resolved to a satisfying store entry. */
export class DependencyResolutionError extends CapsiumError {}

/** A candidate dependency in a package store. */
export interface StoreCandidate {
  readonly guid: string;
  readonly name: string;
  readonly version: string;
}

/**
 * Resolve `metadata.dependencies` (guid → semver range) against store
 * candidates, choosing the newest satisfying version per dependency.
 * Throws DependencyResolutionError listing every unsatisfiable dependency.
 */
export function planDependencies(
  dependencies: Readonly<Record<string, string>>,
  candidates: readonly StoreCandidate[],
): Map<string, StoreCandidate> {
  const plan = new Map<string, StoreCandidate>();
  const failures: string[] = [];
  for (const [guid, range] of Object.entries(dependencies)) {
    const versions = candidates.filter((candidate) => candidate.guid === guid);
    const chosen = newestSatisfying(
      versions.map((version) => version.version),
      range,
    );
    const candidate =
      chosen === null ? undefined : versions.find((entry) => entry.version === chosen);
    if (candidate === undefined) {
      failures.push(`${guid} (${range})`);
    } else {
      plan.set(guid, candidate);
    }
  }
  if (failures.length > 0) {
    throw new DependencyResolutionError(
      `unsatisfiable package dependencies: ${failures.join(', ')}`,
    );
  }
  return plan;
}

export interface DependencyResourceRef {
  readonly guid: string;
  /** Package-relative path inside the dependency (e.g. `content/app.js`). */
  readonly path: string;
}

/** True when `resource` is a URI-shaped reference (`<guid>/<path>`). */
export function isDependencyResourceRef(resource: string): boolean {
  return resource.includes('://');
}

/**
 * Parse a dependency resource reference against the known dependency
 * guids (longest guid prefix wins). Returns null when the reference is
 * not URI-shaped or no dependency guid prefix-matches it.
 */
export function parseDependencyResourceRef(
  resource: string,
  dependencyGuids: Iterable<string>,
): DependencyResourceRef | null {
  if (!isDependencyResourceRef(resource)) {
    return null;
  }
  let best: DependencyResourceRef | null = null;
  for (const guid of dependencyGuids) {
    if (resource.startsWith(`${guid}/`) && resource.length > guid.length + 1) {
      if (best === null || guid.length > best.guid.length) {
        best = { guid, path: resource.slice(guid.length + 1) };
      }
    }
  }
  return best;
}

export type DependencyResourceResolution =
  | { readonly kind: 'found'; readonly path: string; readonly type?: string | undefined }
  | { readonly kind: 'private'; readonly path: string }
  | { readonly kind: 'not-found'; readonly path: string };

/**
 * Resolve a package-relative path against a dependency from the dependent
 * viewpoint: the dependency's layers apply (private layers excluded, §5a)
 * and only `exported` manifest resources are visible — referencing a
 * `private` resource of a dependency is an error (§4a), reported as
 * `private` so reactors can answer with a clear rejection.
 */
export function resolveDependencyResource(
  dependency: CapsiumPackage,
  path: string,
): DependencyResourceResolution {
  const layered = resolveLayeredPath(dependency.files, dependency.storage, path, 'dependent');
  if (layered.kind !== 'found') {
    return { kind: 'not-found', path };
  }
  const resource = dependency.manifest.resources[path];
  if (resource !== undefined && resourceVisibility(resource) === 'private') {
    return { kind: 'private', path };
  }
  return { kind: 'found', path: layered.path, type: resource?.type };
}
