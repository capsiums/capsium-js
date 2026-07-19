/**
 * Scope-prefix mounting: when the worker is mapped under a non-root path
 * (e.g. a wrangler route `example.com/docs/*`), the reactor serves package
 * routes relative to that prefix and never answers requests outside it.
 * Root prefix ('/') is a no-op.
 *
 * Mirrors @capsium/swsws's scope helpers (duplicated here because the
 * swsws public entry transitively pulls node:crypto via bcryptjs, which
 * cannot be bundled for the Workers runtime).
 */

/**
 * The package-relative path for a request pathname, or null when the path
 * is outside the prefix — the reactor must not respond to those requests.
 * A trailing slash on `prefix` is optional.
 */
export function stripScopePrefix(pathname: string, prefix: string): string | null {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  if (base === '') {
    return pathname;
  }
  if (pathname === base) {
    return '/';
  }
  if (!pathname.startsWith(`${base}/`)) {
    return null;
  }
  return pathname.slice(base.length);
}
