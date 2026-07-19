/**
 * JS handler-route execution (ARCHITECTURE.md §4a): routes with
 * `{method, handler}` execute in the service worker as ES modules. The
 * handler source is read from the package and imported through a blob: URL
 * (browser) or data: URL (Node, which cannot import blob: URLs) — never
 * from the network. The module's default export (or named `fetch` export)
 * is called with the fetch-style Request and must produce the Response:
 *
 *   export default async (request: Request) => new Response('ok');
 *
 * Error mapping: missing module → 502, import failure → 502, no callable
 * entry export → 502, non-Response return → 502, handler exception → 500.
 *
 * SANDBOXING CAVEAT: a service worker has no real sandbox — handler code
 * runs with the worker's full privileges (same origin, Cache API, fetch).
 * Only install packages from sources you trust; deploy CSP (e.g.
 * `script-src 'self' blob:`) on the page to constrain module loading.
 */
import { type HandlerRoute } from '@capsium/core';
import { textResponse } from './responses.js';

/**
 * Imports an ES module from source text. `(source, path)` — `path` is the
 * package-relative handler path (used for errors and cache keys only).
 */
export type SourceImporter = (source: string, path: string) => Promise<Record<string, unknown>>;

function canUseBlobUrls(): boolean {
  return (
    typeof Blob === 'function' &&
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    (typeof process === 'undefined' || process.versions?.node === undefined)
  );
}

/**
 * The default module loader: dynamic import of an in-memory URL. Blob URLs
 * in browsers/service workers, data: URLs under Node (tests).
 */
export async function importHandlerSource(
  source: string,
  _path: string,
): Promise<Record<string, unknown>> {
  if (canUseBlobUrls()) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    try {
      return (await import(url)) as Record<string, unknown>;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const specifier = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`;
  return (await import(specifier)) as Record<string, unknown>;
}

type HandlerEntry = (request: Request) => unknown;

const decoder = new TextDecoder();

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Executes JS handler routes against package content. Imported modules are
 * cached per (file map, handler path) pair (ES module semantics) for the
 * executor's lifetime — one executor per installed package model, with
 * dependency file maps cached separately.
 */
export class HandlerExecutor {
  private readonly modules = new WeakMap<
    ReadonlyMap<string, Uint8Array>,
    Map<string, Promise<Record<string, unknown>>>
  >();

  constructor(private readonly importSource: SourceImporter = importHandlerSource) {}

  /** Execute the handler for `route` against `request`, returning its Response. */
  async execute(
    route: HandlerRoute,
    request: Request,
    files: ReadonlyMap<string, Uint8Array>,
  ): Promise<Response> {
    const sourceBytes = files.get(route.handler);
    if (sourceBytes === undefined) {
      return textResponse(`handler module missing from package: ${route.handler}`, 502);
    }
    let module: Record<string, unknown>;
    try {
      module = await this.load(files, route.handler, decoder.decode(sourceBytes));
    } catch (error) {
      return textResponse(
        `failed to import handler module ${route.handler}: ${messageOf(error)}`,
        502,
      );
    }
    const entry = (module['default'] ?? module['fetch']) as HandlerEntry | undefined;
    if (typeof entry !== 'function') {
      return textResponse(
        `handler module ${route.handler} has no callable default/fetch export`,
        502,
      );
    }
    let result: unknown;
    try {
      result = await entry(request);
    } catch (error) {
      return textResponse(`handler ${route.handler} threw: ${messageOf(error)}`, 500);
    }
    if (!(result instanceof Response)) {
      return textResponse(`handler ${route.handler} did not return a Response`, 502);
    }
    return result;
  }

  private load(
    files: ReadonlyMap<string, Uint8Array>,
    path: string,
    source: string,
  ): Promise<Record<string, unknown>> {
    let forFiles = this.modules.get(files);
    if (forFiles === undefined) {
      forFiles = new Map();
      this.modules.set(files, forFiles);
    }
    let pending = forFiles.get(path);
    if (pending === undefined) {
      pending = this.importSource(source, path);
      forFiles.set(path, pending);
    }
    return pending;
  }
}
