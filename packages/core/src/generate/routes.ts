/**
 * routes.json auto-generation (ARCHITECTURE.md §4).
 *
 * Rules, exactly:
 * - `index` -> `content/index.html` (when present in the manifest).
 * - Every manifest resource gets a route with its path relative to `content/`.
 * - HTML files (MIME `text/html`) get TWO routes: the path without extension
 *   AND the full filename.
 * - The index HTML additionally gets `/` (emitted first).
 * - Every dataset in storage.json gets `/api/v1/data/<id>`.
 *
 * Output order is deterministic: `/`, then resource routes in sorted path
 * order, then dataset routes in sorted id order.
 */
import type { Manifest } from '../manifest.js';
import type { Routes, Route } from '../routes.js';
import { DATASET_ROUTE_PREFIX } from '../routes.js';
import type { Storage } from '../storage.js';
import { CONTENT_DIR } from './manifest.js';

export const INDEX_HTML = 'content/index.html';

const HTML_MIME_TYPE = 'text/html';
const HTML_EXTENSIONS = ['.html', '.htm'] as const;

function routePathFor(resourcePath: string): string {
  const relative = resourcePath.startsWith(CONTENT_DIR)
    ? resourcePath.slice(CONTENT_DIR.length)
    : resourcePath;
  return `/${relative}`;
}

function stripHtmlExtension(path: string): string {
  for (const ext of HTML_EXTENSIONS) {
    if (path.endsWith(ext)) {
      return path.slice(0, -ext.length);
    }
  }
  return path;
}

export function buildRoutes(manifest: Manifest, storage?: Storage): Routes {
  const routes: Route[] = [];
  const resourcePaths = Object.keys(manifest.resources).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );

  const hasIndex = resourcePaths.includes(INDEX_HTML);
  if (hasIndex) {
    routes.push({ path: '/', resource: INDEX_HTML });
  }

  for (const resourcePath of resourcePaths) {
    const resource = manifest.resources[resourcePath];
    if (resource === undefined) {
      continue;
    }
    const fullPath = routePathFor(resourcePath);
    if (resource.type === HTML_MIME_TYPE) {
      routes.push({ path: stripHtmlExtension(fullPath), resource: resourcePath });
      routes.push({ path: fullPath, resource: resourcePath });
    } else {
      routes.push({ path: fullPath, resource: resourcePath });
    }
  }

  if (storage !== undefined) {
    const dataSetIds = Object.keys(storage.storage.dataSets).sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const id of dataSetIds) {
      routes.push({ path: `${DATASET_ROUTE_PREFIX}${id}`, dataset: id });
    }
  }

  return hasIndex ? { index: INDEX_HTML, routes } : { routes };
}
