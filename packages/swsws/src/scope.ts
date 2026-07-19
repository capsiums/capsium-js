/**
 * Scope-prefix mounting: registered at a non-root scope — e.g.
 * /playground/~serve/ — the reactor serves package routes relative to the
 * registration scope's pathname prefix instead of the origin root. Root
 * scope ('/') is a no-op: routes resolve exactly as before. Pure and
 * framework-free so it is unit-testable outside a service worker.
 */

/**
 * The package-relative path for a request pathname, or null when the path
 * is outside the scope — the reactor must not respond to those requests.
 * `prefix` is the scope's pathname; a trailing slash is optional.
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

/**
 * Re-apply the scope prefix to a package-relative path — for absolute
 * redirect targets the reactor emits (e.g. the OAuth2 redirect_uri), which
 * must point back inside the scope for the worker to intercept them.
 */
export function joinScopePrefix(prefix: string, path: string): string {
  const base = prefix.endsWith('/') ? prefix.slice(0, -1) : prefix;
  return `${base}${path}`;
}
