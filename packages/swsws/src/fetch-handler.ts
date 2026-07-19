/**
 * The reactor request pipeline, factored pure-ish for unit tests: given a
 * Request and a package store, produce a Response per routes.json and the
 * §7 introspection API.
 *
 * JS handler routes (§4a: `{path, method, handler}`) execute as ES modules
 * via HandlerExecutor; non-JS handlers (e.g. `.lua`) are answered 501 —
 * this reactor executes JavaScript only.
 *
 * Composite packages (§4a): resource routes whose `resource` (or handler
 * routes whose `handler`) is a `capsium://<guid>/<path>` reference are
 * served from the installed dependency — only `exported` resources are
 * visible (referencing a dependency's `private` resource is rejected).
 * Route inheritance attributes are honored at serve time: `remap`
 * (resolution), `responseRewrite` (body/headers override), additive
 * `responseHeaders` and `requestHeaders` (handler forwarding).
 */
import {
  isDependencyResourceRef,
  isJavaScriptHandlerPath,
  isSchemaFileDataset,
  mimeTypeForPath,
  parseDependencyResourceRef,
  resolveDependencyResource,
  resolveLayeredPath,
  FALLBACK_MIME_TYPE,
  type CapsiumPackage,
  type ContentHashesResponse,
  type ContentValidityResponse,
  type HandlerRoute,
  type IntrospectMetadataResponse,
  type IntrospectRoutesResponse,
  type ResourceRoute,
} from '@capsium/core';
import { matchIntrospection, RouteResolver, type IntrospectionEndpoint } from './resolver.js';
import { HandlerExecutor, type SourceImporter } from './handler-executor.js';
import { jsonResponse, textResponse } from './responses.js';
import type { InstalledPackage, PackageStore } from './package-store.js';

/** Options for request handling (mainly test seams). */
export interface HandleRequestOptions {
  /**
   * Module loader override for handler execution (mock in tests). Applies
   * only the first time an executor is created for a given installed
   * package model.
   */
  readonly importSource?: SourceImporter;
}

/** One executor per installed package model (module cache follows the package). */
const executors = new WeakMap<CapsiumPackage, HandlerExecutor>();

function executorFor(model: CapsiumPackage, importSource?: SourceImporter): HandlerExecutor {
  let executor = executors.get(model);
  if (executor === undefined) {
    executor = new HandlerExecutor(importSource);
    executors.set(model, executor);
  }
  return executor;
}

function describeIssues(installed: InstalledPackage): string | undefined {
  if (installed.validity.valid) {
    return undefined;
  }
  return installed.validity.issues
    .map((issue) => ('path' in issue ? `${issue.kind}: ${issue.path}` : issue.kind))
    .join('; ');
}

function introspectionResponse(
  endpoint: IntrospectionEndpoint,
  installed: InstalledPackage | undefined,
): Response {
  switch (endpoint) {
    case 'metadata': {
      const body: IntrospectMetadataResponse = {
        packages:
          installed === undefined
            ? []
            : [
                {
                  name: installed.model.metadata.name,
                  version: installed.model.metadata.version,
                  description: installed.model.metadata.description,
                  ...(installed.model.metadata.author !== undefined
                    ? { author: installed.model.metadata.author }
                    : {}),
                },
              ],
      };
      return jsonResponse(body);
    }
    case 'routes': {
      const body: IntrospectRoutesResponse = {
        routes:
          installed === undefined
            ? []
            : [
                {
                  package: installed.model.metadata.name,
                  routes: installed.model.routes.routes.map((route) => ({
                    method: 'handler' in route ? route.method : 'GET',
                    path: route.path,
                  })),
                },
              ],
      };
      return jsonResponse(body);
    }
    case 'contentHashes': {
      const body: ContentHashesResponse = {
        contentHashes:
          installed === undefined
            ? []
            : [{ package: installed.model.metadata.name, hash: installed.contentHash }],
      };
      return jsonResponse(body);
    }
    case 'contentValidity': {
      const reason = installed === undefined ? undefined : describeIssues(installed);
      const body: ContentValidityResponse = {
        contentValidity:
          installed === undefined
            ? []
            : [
                {
                  package: installed.model.metadata.name,
                  valid: installed.validity.valid,
                  lastChecked: installed.validity.checkedAt,
                  ...(reason !== undefined ? { reason } : {}),
                },
              ],
      };
      return jsonResponse(body);
    }
  }
}

/**
 * Apply §4a route inheritance processing to a response: `responseHeaders`
 * are ADDED only when absent, `responseRewrite.headers` override and
 * `responseRewrite.body` replaces the body.
 */
function applyResponseProcessing(
  response: Response,
  route: ResourceRoute | HandlerRoute,
): Response {
  const { responseRewrite, responseHeaders } = route;
  if (responseRewrite === undefined && responseHeaders === undefined) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(responseHeaders ?? {})) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }
  for (const [name, value] of Object.entries(responseRewrite?.headers ?? {})) {
    headers.set(name, value);
  }
  const body = responseRewrite?.body ?? response.body;
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function dependencyGuids(installed: InstalledPackage): string[] {
  return Object.keys(installed.model.metadata.dependencies ?? {});
}

/** Serve a resource route (local or a §4a `capsium://` dependency reference). */
function serveResourceRoute(installed: InstalledPackage, route: ResourceRoute): Response {
  const { model } = installed;

  if (isDependencyResourceRef(route.resource)) {
    const ref = parseDependencyResourceRef(route.resource, dependencyGuids(installed));
    const dependency = ref === null ? undefined : installed.dependencies.get(ref.guid);
    if (ref === null || dependency === undefined) {
      return textResponse(`dependency not installed for reference: ${route.resource}`, 404);
    }
    const resolved = resolveDependencyResource(dependency.model, ref.path);
    if (resolved.kind === 'private') {
      // §4a: referencing a private resource of a dependency is an error.
      return textResponse(`dependency resource is private: ${route.resource}`, 404);
    }
    if (resolved.kind === 'not-found') {
      return textResponse(`dependency resource missing: ${route.resource}`, 404);
    }
    const bytes = dependency.model.files.get(resolved.path);
    if (bytes === undefined) {
      return textResponse(`dependency resource missing: ${route.resource}`, 404);
    }
    const headers = new Headers(route.headers);
    headers.set(
      'Content-Type',
      resolved.type ?? mimeTypeForPath(resolved.path) ?? FALLBACK_MIME_TYPE,
    );
    return applyResponseProcessing(new Response(bytes as BodyInit, { status: 200, headers }), route);
  }

  // §5a: resolve through the storage layers (top → bottom, tombstones 404).
  const layered = resolveLayeredPath(model.files, model.storage, route.resource);
  if (layered.kind === 'tombstoned') {
    return textResponse(`resource deleted: ${route.resource}`, 404);
  }
  if (layered.kind === 'not-found') {
    return textResponse(`resource missing from package: ${route.resource}`, 404);
  }
  const bytes = model.files.get(layered.path);
  if (bytes === undefined) {
    return textResponse(`resource missing from package: ${route.resource}`, 404);
  }
  const manifestResource = model.manifest.resources[route.resource];
  const headers = new Headers(route.headers);
  headers.set(
    'Content-Type',
    manifestResource?.type ?? mimeTypeForPath(route.resource) ?? FALLBACK_MIME_TYPE,
  );
  return applyResponseProcessing(new Response(bytes as BodyInit, { status: 200, headers }), route);
}

/** Execute a handler route (local or a §4a `capsium://` dependency reference). */
async function serveHandlerRoute(
  installed: InstalledPackage,
  route: HandlerRoute,
  request: Request,
  options: HandleRequestOptions,
): Promise<Response> {
  let files = installed.model.files;
  let executorModel = installed.model;
  let handlerPath = route.handler;

  if (isDependencyResourceRef(route.handler)) {
    const ref = parseDependencyResourceRef(route.handler, dependencyGuids(installed));
    const dependency = ref === null ? undefined : installed.dependencies.get(ref.guid);
    if (ref === null || dependency === undefined) {
      return textResponse(`dependency not installed for reference: ${route.handler}`, 404);
    }
    const resolved = resolveDependencyResource(dependency.model, ref.path);
    if (resolved.kind === 'private') {
      return textResponse(`dependency resource is private: ${route.handler}`, 404);
    }
    if (resolved.kind === 'not-found') {
      return textResponse(`handler module missing from dependency: ${route.handler}`, 404);
    }
    files = dependency.model.files;
    executorModel = dependency.model;
    handlerPath = resolved.path;
  }

  if (!isJavaScriptHandlerPath(handlerPath)) {
    // §4a: JS handlers execute ONLY in JS-capable reactors; this
    // reactor cannot execute non-JS (e.g. Lua) handlers.
    return textResponse(`handler kind not executable by this reactor: ${route.handler}`, 501);
  }

  // §4a requestHeaders: supplant request headers before forwarding.
  let forwarded = request;
  if (route.requestHeaders !== undefined) {
    const headers = new Headers(request.headers);
    for (const [name, value] of Object.entries(route.requestHeaders)) {
      headers.set(name, value);
    }
    forwarded = new Request(request, { headers });
  }

  const response = await executorFor(executorModel, options.importSource).execute(
    { ...route, handler: handlerPath },
    forwarded,
    files,
  );
  return applyResponseProcessing(response, route);
}

/** Handle one reactor request (fetch event) against the installed package. */
export async function handleRequest(
  request: Request,
  store: PackageStore,
  options: HandleRequestOptions = {},
): Promise<Response> {
  const { pathname } = new URL(request.url);

  const endpoint = matchIntrospection(pathname);
  if (endpoint !== null) {
    return introspectionResponse(endpoint, store.current);
  }

  const installed = store.current;
  if (installed === undefined) {
    return textResponse('no Capsium package installed', 404);
  }

  const resolution = new RouteResolver(installed.model.routes).resolve(pathname, request.method);
  const { files, storage } = installed.model;
  switch (resolution.kind) {
    case 'resource':
      return serveResourceRoute(installed, resolution.route);
    case 'dataset': {
      const dataset = storage?.storage.dataSets[resolution.route.dataset];
      if (dataset === undefined) {
        return textResponse(`unknown dataset: ${resolution.route.dataset}`, 404);
      }
      if (!isSchemaFileDataset(dataset)) {
        // SQLite querying is out of scope for the minimal browser reactor.
        return textResponse(`dataset kind not served by this reactor: ${resolution.route.dataset}`, 501);
      }
      const layered = resolveLayeredPath(files, storage, dataset.source);
      if (layered.kind === 'tombstoned') {
        return textResponse(`dataset source deleted: ${dataset.source}`, 404);
      }
      const bytes = layered.kind === 'found' ? files.get(layered.path) : undefined;
      if (bytes === undefined) {
        return textResponse(`dataset source missing from package: ${dataset.source}`, 404);
      }
      return new Response(bytes as BodyInit, {
        status: 200,
        headers: {
          'Content-Type': mimeTypeForPath(dataset.source) ?? 'application/json',
        },
      });
    }
    case 'handler':
      return await serveHandlerRoute(installed, resolution.route, request, options);
    case 'method-not-allowed':
      return textResponse(`method ${request.method} not allowed for ${pathname}`, 405, {
        Allow: resolution.allowed.join(', '),
      });
    case 'not-found':
      return textResponse(`no route for ${pathname}`, 404);
  }
}
