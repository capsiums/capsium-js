/**
 * The reactor request pipeline, factored pure-ish for unit tests: given a
 * Request and a package store, produce a Response per routes.json and the
 * §7 introspection API.
 */
import {
  isSchemaFileDataset,
  mimeTypeForPath,
  FALLBACK_MIME_TYPE,
  type ContentHashesResponse,
  type ContentValidityResponse,
  type IntrospectMetadataResponse,
  type IntrospectRoutesResponse,
} from '@capsium/core';
import { matchIntrospection, RouteResolver, type IntrospectionEndpoint } from './resolver.js';
import type { InstalledPackage, PackageStore } from './package-store.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
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
export async function handleRequest(request: Request, store: PackageStore): Promise<Response> {
  const { pathname } = new URL(request.url);

  const endpoint = matchIntrospection(pathname);
  if (endpoint !== null) {
    return introspectionResponse(endpoint, store.current);
  }

  const installed = store.current;
  if (installed === undefined) {
    return textResponse('no Capsium package installed', 404);
  }

  const resolution = new RouteResolver(installed.model.routes).resolve(pathname);
  switch (resolution.kind) {
    case 'resource': {
      const bytes = installed.model.files.get(resolution.route.resource);
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
      const dataset = installed.model.storage?.storage.dataSets[resolution.route.dataset];
      if (dataset === undefined) {
        return textResponse(`unknown dataset: ${resolution.route.dataset}`, 404);
      }
      if (!isSchemaFileDataset(dataset)) {
        // SQLite querying is out of scope for the minimal browser reactor.
        return textResponse(`dataset kind not served by this reactor: ${resolution.route.dataset}`, 501);
      }
      const bytes = installed.model.files.get(dataset.source);
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
      return textResponse('handler routes are not executed by this reactor', 501);
    case 'not-found':
      return textResponse(`no route for ${pathname}`, 404);
  }
}
