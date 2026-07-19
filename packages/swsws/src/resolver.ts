/**
 * Request-path resolution against a routes.json model (ARCHITECTURE.md §4).
 * Pure and framework-free so it is unit-testable outside a service worker.
 */
import {
  isDatasetRoute,
  isHandlerRoute,
  isResourceRoute,
  type DatasetRoute,
  type ResourceRoute,
  type Route,
  type Routes,
} from '@capsium/core';

export type Resolution =
  | { readonly kind: 'resource'; readonly route: ResourceRoute }
  | { readonly kind: 'dataset'; readonly route: DatasetRoute }
  | { readonly kind: 'handler' }
  | { readonly kind: 'not-found' };

export class RouteResolver {
  private readonly byPath: ReadonlyMap<string, Route>;

  constructor(routes: Routes) {
    const byPath = new Map<string, Route>();
    for (const route of routes.routes) {
      if (!byPath.has(route.path)) {
        byPath.set(route.path, route);
      }
    }
    this.byPath = byPath;
  }

  /** Resolve a request pathname (e.g. `/about`) to a route resolution. */
  resolve(pathname: string): Resolution {
    const route = this.byPath.get(pathname);
    if (route === undefined) {
      return { kind: 'not-found' };
    }
    if (isResourceRoute(route)) {
      return { kind: 'resource', route };
    }
    if (isDatasetRoute(route)) {
      return { kind: 'dataset', route };
    }
    if (isHandlerRoute(route)) {
      return { kind: 'handler' };
    }
    return { kind: 'not-found' };
  }
}

/** Reactor introspection endpoints (ARCHITECTURE.md §7). */
export const INTROSPECTION_PATHS = {
  metadata: '/api/v1/introspect/metadata',
  routes: '/api/v1/introspect/routes',
  contentHashes: '/api/v1/introspect/content-hashes',
  contentValidity: '/api/v1/introspect/content-validity',
} as const;

export type IntrospectionEndpoint = keyof typeof INTROSPECTION_PATHS;

export function matchIntrospection(pathname: string): IntrospectionEndpoint | null {
  for (const [endpoint, path] of Object.entries(INTROSPECTION_PATHS)) {
    if (path === pathname) {
      return endpoint as IntrospectionEndpoint;
    }
  }
  return null;
}
