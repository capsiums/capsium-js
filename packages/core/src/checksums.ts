/**
 * Checksum computation and verification (ARCHITECTURE.md §6).
 * Isomorphic: works with any injected HashProvider.
 *
 * Checksums cover EVERY file in the package except `security.json` itself.
 * Verification reports a typed issue list; reactors reject on any issue.
 */
import { SECURITY_FILE, type Security } from './security.js';
import type { HashProvider } from './hash-provider.js';

export type IntegrityIssue =
  | { readonly kind: 'missing-security-file' }
  | { readonly kind: 'unsupported-algorithm'; readonly algorithm: string }
  | { readonly kind: 'missing-file'; readonly path: string; readonly expected: string }
  | { readonly kind: 'checksum-mismatch'; readonly path: string; readonly expected: string; readonly actual: string }
  | { readonly kind: 'uncovered-file'; readonly path: string };

export interface IntegrityReport {
  readonly valid: boolean;
  readonly checkedAt: string;
  readonly issues: readonly IntegrityIssue[];
}

function sortedPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** SHA-256 checksums for every file except `security.json`, keyed by sorted path. */
export async function computeChecksums(
  files: ReadonlyMap<string, Uint8Array>,
  hashProvider: HashProvider,
): Promise<Record<string, string>> {
  const checksums: Record<string, string> = {};
  for (const path of sortedPaths(files.keys())) {
    if (path === SECURITY_FILE) {
      continue;
    }
    const bytes = files.get(path);
    if (bytes === undefined) {
      continue;
    }
    checksums[path] = await hashProvider.digestHex(bytes);
  }
  return checksums;
}

/** Build a security.json model covering every file except `security.json`. */
export async function buildSecurity(
  files: ReadonlyMap<string, Uint8Array>,
  hashProvider: HashProvider,
): Promise<Security> {
  const checksums = await computeChecksums(files, hashProvider);
  return {
    security: {
      integrityChecks: {
        checksumAlgorithm: 'SHA-256',
        checksums,
      },
    },
  };
}

/**
 * Recompute checksums of `files` and compare against `security`.
 * Files present on disk but absent from the checksum list (other than
 * `security.json`) are reported as `uncovered-file`. A package without
 * security.json cannot be verified and is reported invalid with a
 * `missing-security-file` issue.
 */
export async function verifyIntegrity(
  files: ReadonlyMap<string, Uint8Array>,
  security: Security | undefined,
  hashProvider: HashProvider,
): Promise<IntegrityReport> {
  const issues: IntegrityIssue[] = [];

  if (security === undefined) {
    issues.push({ kind: 'missing-security-file' });
    return { valid: false, checkedAt: new Date().toISOString(), issues };
  }
  const { checksumAlgorithm, checksums } = security.security.integrityChecks;

  if (checksumAlgorithm !== hashProvider.algorithm) {
    issues.push({ kind: 'unsupported-algorithm', algorithm: checksumAlgorithm });
  } else {
    for (const path of sortedPaths(Object.keys(checksums))) {
      const expected = checksums[path];
      if (expected === undefined) {
        continue;
      }
      const bytes = files.get(path);
      if (bytes === undefined) {
        issues.push({ kind: 'missing-file', path, expected });
        continue;
      }
      const actual = await hashProvider.digestHex(bytes);
      if (actual !== expected) {
        issues.push({ kind: 'checksum-mismatch', path, expected, actual });
      }
    }
    for (const path of sortedPaths(files.keys())) {
      if (path !== SECURITY_FILE && !(path in checksums)) {
        issues.push({ kind: 'uncovered-file', path });
      }
    }
  }

  return { valid: issues.length === 0, checkedAt: new Date().toISOString(), issues };
}
