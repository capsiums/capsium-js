/**
 * The Cloudflare Workers request pipeline: Request in, Response out.
 * Semantics mirror the Node reactor's ServingPipeline and the Ruby reactor
 * (ARCHITECTURE.md §4, §5a, §7), expressed with Fetch API primitives:
 *
 * - Resource routes serve bytes through the §5a storage layers (top →
 *   bottom; tombstoned paths 404) with the manifest MIME type and a
 *   `Cache-Control` default that route-level `headers` override wholesale.
 * - §4a composite routes (`capsium://<guid>/<path>`) answer 404: this
 *   reactor installs a single .cap and resolves no dependencies.
 * - Route inheritance processing: `responseRewrite` (body/headers override)
 *   and additive `responseHeaders` are honored at serve time.
 * - Dataset routes serve the dataset source as JSON (SQLite datasets are
 *   out of scope → 501, as in the other reactors).
 * - Handler routes are not executed by this reactor → 501.
 * - Only GET/HEAD are served; anything else is 405 with `Allow`. HEAD is
 *   answered by the worker layer (same headers, null body).
 * - Errors are JSON problem bodies `{error}`.
 */
import {
  isDependencyResourceRef,
  isSchemaFileDataset,
  matchIntrospection,
  mimeTypeForPath,
  resolveLayeredPath,
  RouteResolver,
  FALLBACK_MIME_TYPE,
  type DatasetRoute,
  type ResourceRoute,
} from '@capsium/core';
import { introspectionReport } from './introspection.js';
import type { InstalledPackage } from './store.js';

/** Default Cache-Control for static resources (route-level headers override). */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000';

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

function jsonResponse(status: number, value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonError(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

function methodNotAllowed(method: string, pathname: string, allowed: readonly string[]): Response {
  return jsonResponse(
    405,
    { error: `method ${method} not allowed for ${pathname}` },
    { Allow: allowed.join(', ') },
  );
}

export class ServingPipeline {
  private readonly resolver: RouteResolver | undefined;

  constructor(
    private readonly installed: InstalledPackage | undefined,
    private readonly cacheControl: string = DEFAULT_CACHE_CONTROL,
  ) {
    this.resolver =
      installed === undefined ? undefined : new RouteResolver(installed.model.routes);
  }

  /**
   * Compute the response for one request. `pathname` is the
   * package-relative path (scope prefix already stripped); `method` is the
   * uppercased request method. HEAD is treated as GET here (the worker
   * layer nulls the body).
   *
   * The §7 introspection endpoints answer even before any install (empty
   * list shapes, as in swsws); package routes 404 while nothing is
   * installed.
   */
  serve(pathname: string, method: string): Response {
    const endpoint = matchIntrospection(pathname);
    if (endpoint !== null) {
      if (!READ_METHODS.has(method)) {
        return methodNotAllowed(method, pathname, [...READ_METHODS]);
      }
      return jsonResponse(200, introspectionReport(endpoint, this.installed));
    }

    const installed = this.installed;
    if (installed === undefined || this.resolver === undefined) {
      return jsonError(404, 'no Capsium package installed');
    }

    const resolution = this.resolver.resolve(pathname, method);
    switch (resolution.kind) {
      case 'resource':
        if (!READ_METHODS.has(method)) {
          return methodNotAllowed(method, pathname, [...READ_METHODS]);
        }
        return this.serveResourceRoute(installed, resolution.route);
      case 'dataset':
        if (!READ_METHODS.has(method)) {
          return methodNotAllowed(method, pathname, [...READ_METHODS]);
        }
        return this.serveDatasetRoute(installed, resolution.route);
      case 'handler':
        // §4: handler routes are out of scope for this reactor (Workers
        // handlers are a follow-up; swsws executes JS handlers).
        return jsonError(
          501,
          `handler route not executable by this reactor: ${resolution.route.handler}`,
        );
      case 'method-not-allowed':
        return methodNotAllowed(method, pathname, resolution.allowed);
      case 'not-found':
        return jsonError(404, `no route for ${pathname}`);
    }
  }

  /** Serve a resource route (local, through the §5a layers). */
  private serveResourceRoute(installed: InstalledPackage, route: ResourceRoute): Response {
    const { model } = installed;

    if (isDependencyResourceRef(route.resource)) {
      // §4a: composite dependency installation is out of scope here.
      return jsonError(404, `dependency not installed for reference: ${route.resource}`);
    }

    const layered = resolveLayeredPath(model.files, model.storage, route.resource);
    if (layered.kind === 'tombstoned') {
      return jsonError(404, `resource deleted: ${route.resource}`);
    }
    const bytes = layered.kind === 'found' ? model.files.get(layered.path) : undefined;
    if (bytes === undefined) {
      return jsonError(404, `resource missing from package: ${route.resource}`);
    }
    const manifestResource = model.manifest.resources[route.resource];
    const contentType =
      manifestResource?.type ?? mimeTypeForPath(route.resource) ?? FALLBACK_MIME_TYPE;

    // Route headers or the Cache-Control default (route-level `headers`
    // replace the default wholesale); Content-Type is then set from the
    // manifest/detection, winning over declared headers.
    const headers = new Headers(route.headers ?? { 'Cache-Control': this.cacheControl });
    headers.set('Content-Type', contentType);
    return this.respond(bytes, headers, route);
  }

  /** Serve a dataset route: the schema-file source as a JSON response. */
  private serveDatasetRoute(installed: InstalledPackage, route: DatasetRoute): Response {
    const { model } = installed;
    const dataset = model.storage?.storage.dataSets[route.dataset];
    if (dataset === undefined) {
      return jsonError(404, `unknown dataset: ${route.dataset}`);
    }
    if (!isSchemaFileDataset(dataset)) {
      // SQLite querying is out of scope for this reactor (as in swsws).
      return jsonError(501, `dataset kind not served by this reactor: ${route.dataset}`);
    }
    const layered = resolveLayeredPath(model.files, model.storage, dataset.source);
    if (layered.kind === 'tombstoned') {
      return jsonError(404, `dataset source deleted: ${dataset.source}`);
    }
    const bytes = layered.kind === 'found' ? model.files.get(layered.path) : undefined;
    if (bytes === undefined) {
      return jsonError(404, `dataset source missing from package: ${dataset.source}`);
    }
    return new Response(bytes as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': mimeTypeForPath(dataset.source) ?? 'application/json',
        'Content-Length': String(bytes.length),
      },
    });
  }

  /**
   * Apply §4a route inheritance processing (`responseHeaders` additive,
   * `responseRewrite` overriding) and attach the final Content-Length.
   */
  private respond(bytes: Uint8Array, headers: Headers, route: ResourceRoute): Response {
    for (const [name, value] of Object.entries(route.responseHeaders ?? {})) {
      if (!headers.has(name)) {
        headers.set(name, value);
      }
    }
    for (const [name, value] of Object.entries(route.responseRewrite?.headers ?? {})) {
      headers.set(name, value);
    }
    const body =
      route.responseRewrite?.body !== undefined
        ? new TextEncoder().encode(route.responseRewrite.body)
        : bytes;
    headers.set('Content-Length', String(body.length));
    return new Response(body as BodyInit, { status: 200, headers });
  }
}
