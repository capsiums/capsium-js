/**
 * Request-path resolution against a routes.json model (ARCHITECTURE.md §4),
 * shared by every JavaScript reactor (service worker, Node). Pure and
 * framework-free so it is unit-testable anywhere.
 *
 * Handler routes (`{path, method, handler}`) match on BOTH path and method
 * (§4a); a path whose handler routes only declare other methods resolves to
 * `method-not-allowed` with the allowed methods.
 */
import {
  effectiveRoutePath,
  isDatasetRoute,
  isHandlerRoute,
  isResourceRoute,
  type DatasetRoute,
  type HandlerRoute,
  type ResourceRoute,
  type Route,
  type Routes,
} from './routes.js';

export type Resolution =
  | { readonly kind: 'resource'; readonly route: ResourceRoute }
  | { readonly kind: 'dataset'; readonly route: DatasetRoute }
  | { readonly kind: 'handler'; readonly route: HandlerRoute }
  | { readonly kind: 'method-not-allowed'; readonly allowed: readonly string[] }
  | { readonly kind: 'not-found' };

export class RouteResolver {
  private readonly byPath: ReadonlyMap<string, Route>;
  private readonly handlersByPath: ReadonlyMap<string, HandlerRoute[]>;

  constructor(routes: Routes) {
    const byPath = new Map<string, Route>();
    const handlersByPath = new Map<string, HandlerRoute[]>();
    for (const route of routes.routes) {
      // §4a route inheritance: a route with `remap` is served at the
      // remapped path.
      const servedPath = effectiveRoutePath(route);
      if (isHandlerRoute(route)) {
        const handlers = handlersByPath.get(servedPath) ?? [];
        handlers.push(route);
        handlersByPath.set(servedPath, handlers);
      } else if (!byPath.has(servedPath)) {
        byPath.set(servedPath, route);
      }
    }
    this.byPath = byPath;
    this.handlersByPath = handlersByPath;
  }

  /** Resolve a request pathname (e.g. `/about`) and method to a route resolution. */
  resolve(pathname: string, method = 'GET'): Resolution {
    const handlers = this.handlersByPath.get(pathname) ?? [];
    const match = handlers.find(
      (handler) => handler.method.toUpperCase() === method.toUpperCase(),
    );
    if (match !== undefined) {
      return { kind: 'handler', route: match };
    }
    const route = this.byPath.get(pathname);
    if (route !== undefined) {
      if (isResourceRoute(route)) {
        return { kind: 'resource', route };
      }
      if (isDatasetRoute(route)) {
        return { kind: 'dataset', route };
      }
    }
    if (handlers.length > 0) {
      return {
        kind: 'method-not-allowed',
        allowed: handlers.map((handler) => handler.method.toUpperCase()),
      };
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
