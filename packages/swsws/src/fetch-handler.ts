/**
 * The reactor request pipeline, factored pure-ish for unit tests: given a
 * Request and a package store, produce a Response per routes.json and the
 * §7 introspection API.
 *
 * JS handler routes (§4a: `{path, method, handler}`) execute as ES modules
 * via HandlerExecutor; non-JS handlers (e.g. `.lua`) are answered 501 —
 * this reactor executes JavaScript only.
 */
import {
  isJavaScriptHandlerPath,
  isSchemaFileDataset,
  mimeTypeForPath,
  resolveLayeredPath,
  FALLBACK_MIME_TYPE,
  type CapsiumPackage,
  type ContentHashesResponse,
  type ContentValidityResponse,
  type IntrospectMetadataResponse,
  type IntrospectRoutesResponse,
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
    case 'resource': {
      // §5a: resolve through the storage layers (top → bottom, tombstones 404).
      const layered = resolveLayeredPath(files, storage, resolution.route.resource);
      if (layered.kind === 'tombstoned') {
        return textResponse(`resource deleted: ${resolution.route.resource}`, 404);
      }
      if (layered.kind === 'not-found') {
        return textResponse(`resource missing from package: ${resolution.route.resource}`, 404);
      }
      const bytes = files.get(layered.path);
      if (bytes === undefined) {
        return textResponse(`resource missing from package: ${resolution.route.resource}`, 404);
      }
      const manifestResource = installed.model.manifest.resources[resolution.route.resource];
      const headers = new Headers(resolution.route.headers);
      headers.set(
        'Content-Type',
        manifestResource?.type ?? mimeTypeForPath(resolution.route.resource) ?? FALLBACK_MIME_TYPE,
      );
      return new Response(bytes as BodyInit, { status: 200, headers });
    }
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
    case 'handler': {
      if (!isJavaScriptHandlerPath(resolution.route.handler)) {
        // §4a: JS handlers execute ONLY in JS-capable reactors; this
        // reactor cannot execute non-JS (e.g. Lua) handlers.
        return textResponse(
          `handler kind not executable by this reactor: ${resolution.route.handler}`,
          501,
        );
      }
      return await executorFor(installed.model, options.importSource).execute(
        resolution.route,
        request,
        installed.model.files,
      );
    }
    case 'method-not-allowed':
      return textResponse(`method ${request.method} not allowed for ${pathname}`, 405, {
        Allow: resolution.allowed.join(', '),
      });
    case 'not-found':
      return textResponse(`no route for ${pathname}`, 404);
  }
}
