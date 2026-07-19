/**
 * The Node reactor request pipeline, pure and framework-free: pathname +
 * method in, response descriptor out. Semantics mirror the swsws fetch
 * handler and the Ruby reactor (ARCHITECTURE.md §4, §5a, §7):
 *
 * - Resource routes serve bytes through the §5a storage layers (top →
 *   bottom; tombstoned paths 404) with the manifest MIME type and a
 *   `Cache-Control` default that route-level `headers` override.
 * - §4a composite routes (`capsium://<guid>/<path>`) serve from the
 *   installed dependency; only `exported` resources are visible.
 * - Route inheritance processing: `responseRewrite` (body/headers override)
 *   and additive `responseHeaders` are honored at serve time.
 * - Dataset routes serve the dataset source as JSON (SQLite datasets are
 *   out of scope → 501, as in the minimal browser reactor).
 * - Handler routes are not executed by this reactor → 501.
 * - Only GET/HEAD are served; anything else is 405 with `Allow`.
 * - Unknown paths within the package get a JSON 404.
 */
import {
  isDependencyResourceRef,
  isSchemaFileDataset,
  matchIntrospection,
  mimeTypeForPath,
  parseDependencyResourceRef,
  resolveDependencyResource,
  resolveLayeredPath,
  RouteResolver,
  FALLBACK_MIME_TYPE,
  type DatasetRoute,
  type ResourceRoute,
} from '@capsium/core';
import { introspectionReport } from './introspection.js';
import type { LoadedPackage } from './loader.js';

/** A fully-computed response (header names are lowercase). */
export interface ReactorResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Uint8Array;
}

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
const encoder = new TextEncoder();

function json(status: number, value: unknown): ReactorResponse {
  return {
    status,
    headers: new Map([['content-type', 'application/json']]),
    body: encoder.encode(JSON.stringify(value)),
  };
}

function jsonError(status: number, message: string): ReactorResponse {
  return json(status, { error: message });
}

function methodNotAllowed(method: string, pathname: string, allowed: readonly string[]): ReactorResponse {
  const response = jsonError(405, `method ${method} not allowed for ${pathname}`);
  return {
    ...response,
    headers: new Map([...response.headers, ['allow', allowed.join(', ')]]),
  };
}

/** Case-insensitive header accumulator (HTTP header names fold to lowercase). */
class HeaderBag {
  private readonly values = new Map<string, string>();

  constructor(entries?: Readonly<Record<string, string>>) {
    for (const [name, value] of Object.entries(entries ?? {})) {
      this.set(name, value);
    }
  }

  set(name: string, value: string): void {
    this.values.set(name.toLowerCase(), value);
  }

  /** §4a responseHeaders semantics: added only when not already present. */
  setIfAbsent(name: string, value: string): void {
    if (!this.values.has(name.toLowerCase())) {
      this.set(name, value);
    }
  }

  toMap(): ReadonlyMap<string, string> {
    return this.values;
  }
}

export class ServingPipeline {
  private readonly resolver: RouteResolver;

  constructor(
    private readonly loaded: LoadedPackage,
    private readonly cacheControl: string,
  ) {
    this.resolver = new RouteResolver(loaded.model.routes);
  }

  /** Compute the response for one request (method already uppercased). */
  serve(pathname: string, method: string): ReactorResponse {
    const endpoint = matchIntrospection(pathname);
    if (endpoint !== null) {
      if (!READ_METHODS.has(method)) {
        return methodNotAllowed(method, pathname, [...READ_METHODS]);
      }
      return json(200, introspectionReport(endpoint, this.loaded));
    }

    const resolution = this.resolver.resolve(pathname, method);
    switch (resolution.kind) {
      case 'resource':
        if (!READ_METHODS.has(method)) {
          return methodNotAllowed(method, pathname, [...READ_METHODS]);
        }
        return this.serveResourceRoute(resolution.route);
      case 'dataset':
        if (!READ_METHODS.has(method)) {
          return methodNotAllowed(method, pathname, [...READ_METHODS]);
        }
        return this.serveDatasetRoute(resolution.route);
      case 'handler':
        // §4: handler routes are out of scope for this reactor (the package
        // model carries them; execution is a JS-reactor follow-up).
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

  /** Serve a resource route (local, through the §5a layers, or §4a dependency). */
  private serveResourceRoute(route: ResourceRoute): ReactorResponse {
    const { model } = this.loaded;

    if (isDependencyResourceRef(route.resource)) {
      const ref = parseDependencyResourceRef(
        route.resource,
        Object.keys(model.metadata.dependencies ?? {}),
      );
      const dependency = ref === null ? undefined : this.loaded.dependencies.get(ref.guid);
      if (ref === null || dependency === undefined) {
        return jsonError(404, `dependency not installed for reference: ${route.resource}`);
      }
      const resolved = resolveDependencyResource(dependency.model, ref.path);
      if (resolved.kind === 'private') {
        // §4a: referencing a private resource of a dependency is an error.
        return jsonError(404, `dependency resource is private: ${route.resource}`);
      }
      if (resolved.kind === 'not-found') {
        return jsonError(404, `dependency resource missing: ${route.resource}`);
      }
      const bytes = dependency.model.files.get(resolved.path);
      if (bytes === undefined) {
        return jsonError(404, `dependency resource missing: ${route.resource}`);
      }
      const headers = this.baseHeaders(
        route,
        resolved.type ?? mimeTypeForPath(resolved.path) ?? FALLBACK_MIME_TYPE,
      );
      return this.respond(bytes, headers, route);
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
    const headers = this.baseHeaders(
      route,
      manifestResource?.type ?? mimeTypeForPath(route.resource) ?? FALLBACK_MIME_TYPE,
    );
    return this.respond(bytes, headers, route);
  }

  /** Serve a dataset route: the schema-file source as a JSON response. */
  private serveDatasetRoute(route: DatasetRoute): ReactorResponse {
    const { model } = this.loaded;
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
    return {
      status: 200,
      headers: new Map([
        ['content-type', mimeTypeForPath(dataset.source) ?? 'application/json'],
        ['content-length', String(bytes.length)],
      ]),
      body: bytes,
    };
  }

  /**
   * Route headers or the `Cache-Control` default (route-level `headers`
   * replace the default wholesale, per the Ruby reactor); Content-Type is
   * then set from the manifest/detection, winning over declared headers.
   */
  private baseHeaders(route: ResourceRoute, contentType: string): HeaderBag {
    const headers = new HeaderBag(route.headers ?? { 'Cache-Control': this.cacheControl });
    headers.set('Content-Type', contentType);
    return headers;
  }

  /**
   * Apply §4a route inheritance processing (`responseHeaders` additive,
   * `responseRewrite` overriding) and attach the final Content-Length.
   */
  private respond(bytes: Uint8Array, headers: HeaderBag, route: ResourceRoute): ReactorResponse {
    for (const [name, value] of Object.entries(route.responseHeaders ?? {})) {
      headers.setIfAbsent(name, value);
    }
    for (const [name, value] of Object.entries(route.responseRewrite?.headers ?? {})) {
      headers.set(name, value);
    }
    const body = route.responseRewrite?.body !== undefined
      ? encoder.encode(route.responseRewrite.body)
      : bytes;
    headers.set('Content-Length', String(body.length));
    return { status: 200, headers: headers.toMap(), body };
  }
}
