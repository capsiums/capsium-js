/**
 * Minimal semver comparison and range matching (ARCHITECTURE.md §4a needs
 * "newest satisfying version" for dependency resolution). Isomorphic, no
 * dependency. Supported range forms (space-separated AND):
 * exact (`1.2.3`), wildcards (`1.2.x`, `1.x`), comparators
 * (`>=1.0.0`, `>`, `<=`, `<`, `=`), caret (`^1.2.3`) and tilde (`~1.2.3`).
 * Pre-release/build suffixes compare by the numeric triple only
 * (documented simplification).
 */

export interface Semver {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** Parse `1.2.3` (optional leading v, optional pre-release/build suffix). */
export function parseSemver(version: string): Semver | null {
  const match = VERSION.exec(version.trim());
  if (match === null) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** -1/0/1 comparison on the numeric triple. */
export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (pa === null || pb === null) {
    throw new RangeError(`cannot compare non-semver: ${a} vs ${b}`);
  }
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (pa[key] !== pb[key]) {
      return pa[key] < pb[key] ? -1 : 1;
    }
  }
  return 0;
}

function compareParsed(a: Semver, b: Semver): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (a[key] !== b[key]) {
      return a[key] < b[key] ? -1 : 1;
    }
  }
  return 0;
}

function matchesComparator(version: Semver, comparator: string): boolean {
  const wildcard = /^(?:[=v]?)(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(comparator.trim());
  if (wildcard !== null && (wildcard[2] === undefined || /x|\*/.test(wildcard[2] ?? '') || /x|\*/.test(wildcard[3] ?? ''))) {
    const major = Number(wildcard[1]);
    const minor = wildcard[2] !== undefined && !/x|\*/.test(wildcard[2]) ? Number(wildcard[2]) : null;
    if (version.major !== major) {
      return false;
    }
    return minor === null || version.minor === minor;
  }
  const range = /^(>=|<=|>|<|=|\^|~)?\s*v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(
    comparator.trim(),
  );
  if (range === null) {
    return false;
  }
  const target: Semver = {
    major: Number(range[2]),
    minor: Number(range[3]),
    patch: Number(range[4]),
  };
  const cmp = compareParsed(version, target);
  switch (range[1] ?? '=') {
    case '=':
      return cmp === 0;
    case '>':
      return cmp > 0;
    case '>=':
      return cmp >= 0;
    case '<':
      return cmp < 0;
    case '<=':
      return cmp <= 0;
    case '~':
      return version.major === target.major && version.minor === target.minor && cmp >= 0;
    case '^':
      if (cmp < 0) {
        return false;
      }
      if (target.major > 0) {
        return version.major === target.major;
      }
      if (target.minor > 0) {
        return version.major === 0 && version.minor === target.minor;
      }
      return version.major === 0 && version.minor === 0 && version.patch === target.patch;
    default:
      return false;
  }
}

/** True when `version` satisfies every comparator in `range` (AND). */
export function satisfiesRange(version: string, range: string): boolean {
  const parsed = parseSemver(version);
  if (parsed === null) {
    return false;
  }
  const comparators = range.trim().split(/\s+/).filter(Boolean);
  if (comparators.length === 0) {
    return false;
  }
  return comparators.every((comparator) => matchesComparator(parsed, comparator));
}

/** The newest version satisfying `range`, or null when none does. */
export function newestSatisfying(versions: Iterable<string>, range: string): string | null {
  let best: string | null = null;
  for (const version of versions) {
    if (satisfiesRange(version, range) && (best === null || compareSemver(version, best) > 0)) {
      best = version;
    }
  }
  return best;
}
