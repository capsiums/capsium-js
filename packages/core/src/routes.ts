/**
 * routes.json model (ARCHITECTURE.md §4).
 *
 * Canonical form: top-level optional `index` + `routes` ARRAY of route
 * objects. Route kinds are discriminated by key (MECE):
 * - `{path, resource, headers?|headersFile?, visibility?}` — static file.
 * - `{path, dataset, accessControl?}` — dataset route; path MUST be under
 *   `/api/v1/data/`.
 * - `{path, method, handler, ...}` — dynamic handler route: parsers
 *   accept-and-ignore, reactors respond 501.
 *
 * Legacy-read normalization: an object keyed by path is accepted on read and
 * normalized to the array form. Writers emit only the array form.
 */
import { z } from 'zod';
import { resourceVisibilitySchema } from './manifest.js';

export const DATASET_ROUTE_PREFIX = '/api/v1/data/';

/** Route inheritance processing attributes (05x-routing §Route Inheritance, §4a). */
export const responseRewriteSchema = z.object({
  /** Replace the response body outright. */
  body: z.string().optional(),
  /** Override response headers (wins over the served response's own). */
  headers: z.record(z.string(), z.string()).optional(),
});
export type ResponseRewrite = z.infer<typeof responseRewriteSchema>;

const routeInheritanceAttributes = {
  /** Effective public path the route is served at (defaults to `path`). */
  remap: z.string().min(1).optional(),
  responseRewrite: responseRewriteSchema.optional(),
  /** Added to the response only when not already present. */
  responseHeaders: z.record(z.string(), z.string()).optional(),
  /** Merged into the request before forwarding to a handler (handler routes). */
  requestHeaders: z.record(z.string(), z.string()).optional(),
} as const;

export const resourceRouteSchema = z
  .object({
    path: z.string().min(1),
    resource: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    headersFile: z.string().min(1).optional(),
    visibility: resourceVisibilitySchema.optional(),
    ...routeInheritanceAttributes,
  })
  .refine((route) => !(route.headers !== undefined && route.headersFile !== undefined), {
    message: 'headers and headersFile are mutually exclusive',
  });
export type ResourceRoute = z.infer<typeof resourceRouteSchema>;

export const datasetRouteSchema = z.object({
  path: z.string().regex(/^\/api\/v1\/data\//, 'dataset routes must live under /api/v1/data/'),
  dataset: z.string().min(1),
  accessControl: z.record(z.string(), z.unknown()).optional(),
});
export type DatasetRoute = z.infer<typeof datasetRouteSchema>;

export const handlerRouteSchema = z.looseObject({
  path: z.string().min(1),
  method: z.string().min(1),
  handler: z.string().min(1),
  visibility: resourceVisibilitySchema.optional(),
  ...routeInheritanceAttributes,
});
export type HandlerRoute = z.infer<typeof handlerRouteSchema>;

export const routeSchema = z.union([resourceRouteSchema, datasetRouteSchema, handlerRouteSchema]);
export type Route = z.infer<typeof routeSchema>;

export const routesSchema = z.object({
  index: z.string().min(1).optional(),
  routes: z.array(routeSchema),
});
export type Routes = z.infer<typeof routesSchema>;

export function isResourceRoute(route: Route): route is ResourceRoute {
  return 'resource' in route;
}

export function isDatasetRoute(route: Route): route is DatasetRoute {
  return 'dataset' in route;
}

export function isHandlerRoute(route: Route): route is HandlerRoute {
  return 'handler' in route;
}

/**
 * True when a handler path is JavaScript (`.js`/`.mjs`). Per §4a, JS
 * handlers execute ONLY in JS-capable reactors (swsws/Node); non-JS
 * handlers (e.g. `.lua`) must be answered 501 by reactors that cannot
 * execute them.
 */
export function isJavaScriptHandlerPath(path: string): boolean {
  return /\.m?js$/i.test(path);
}

/** Effective public path of a route: `remap` when declared, else `path`. */
export function effectiveRoutePath(route: { path: string; remap?: string | undefined }): string {
  return route.remap ?? route.path;
}

const legacyRouteValueSchema = z.union([
  z.string().min(1).transform((resource) => ({ resource })),
  z.looseObject({}).transform((value) => value),
]);

/**
 * Parse routes.json, accepting the legacy object-keyed-by-path form and
 * normalizing it to the canonical `{index?, routes: [...]}` array form.
 */
export function parseRoutes(input: unknown): Routes {
  const canonical = routesSchema.safeParse(input);
  if (canonical.success) {
    return canonical.data;
  }
  if (typeof input === 'object' && input !== null && 'routes' in input) {
    const { routes: legacyRoutes, ...rest } = input as { routes: unknown } & Record<
      string,
      unknown
    >;
    if (typeof legacyRoutes === 'object' && legacyRoutes !== null && !Array.isArray(legacyRoutes)) {
      const normalized = Object.entries(legacyRoutes as Record<string, unknown>).map(
        ([path, value]) => ({ path, ...legacyRouteValueSchema.parse(value) }),
      );
      return routesSchema.parse({ ...rest, routes: normalized });
    }
  }
  throw canonical.error;
}
