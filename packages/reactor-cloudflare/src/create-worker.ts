/**
 * `createWorker` — the Cloudflare Workers Capsium reactor factory.
 *
 * The returned object is a module-format Worker handler
 * `{ async fetch(request, env, ctx) }`. All reactor state lives in the
 * closure, so the logic is fully testable (e.g. under miniflare) and the
 * package's default worker entry (`src/worker.ts`) is just
 * `export default createWorker()`.
 *
 * Request routing:
 * - `POST <prefix>/__capsium/install` — install a .cap body. Requires
 *   `Authorization: Bearer <token>` when a token is configured (option
 *   `installToken` or env `INSTALL_TOKEN`): a missing/malformed header is
 *   401, a wrong token 403. With no token configured the endpoint is open
 *   (development mode — set a token before deploying). Verification
 *   failures are typed JSON problem bodies `{error}` (400 malformed,
 *   422 integrity/signature mismatch).
 * - Everything else — serving per routes.json plus the §7 introspection
 *   endpoints (GET/HEAD only; JSON 404/405/501).
 *
 * Startup install: when no package is installed and a package URL is
 * configured (option `packageUrl` or env `PACKAGE_URL`), the first request
 * fetches and installs that .cap before being served.
 *
 * Scope prefix: when the worker is mounted under a path (option
 * `pathPrefix` or env `PATH_PREFIX`, e.g. `/docs`), package routes resolve
 * relative to that prefix and requests outside it get a JSON 404.
 */
import { stripScopePrefix } from './scope.js';
import { InstallRejection } from './errors.js';
import { CachePackageStore, type InstalledPackage } from './store.js';
import { DEFAULT_CACHE_CONTROL, ServingPipeline } from './serving.js';
import { WebCryptoHashProvider } from './webcrypto-hash-provider.js';
import { WebCryptoSignatureProvider } from './webcrypto-signature-provider.js';

/** Install endpoint path (package-relative, i.e. after the scope prefix). */
export const INSTALL_PATH = '/__capsium/install';

/** Environment bindings the worker reads (wrangler `[vars]`). */
export interface CapsiumWorkerEnv {
  /** Bearer token required for POST /__capsium/install (unset = open, dev only). */
  readonly INSTALL_TOKEN?: string;
  /** URL of a .cap to fetch+install at startup when nothing is installed. */
  readonly PACKAGE_URL?: string;
  /** Path prefix the worker is mounted under (e.g. `/docs`); default `/`. */
  readonly PATH_PREFIX?: string;
}

/** Minimal structural type of the Workers execution context. */
export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException?(): void;
}

/** Module-format Worker handler returned by createWorker. */
export interface CapsiumWorker {
  fetch(
    request: Request,
    env: CapsiumWorkerEnv,
    ctx: ExecutionContextLike,
  ): Promise<Response>;
}

export interface CreateWorkerOptions {
  /** Bearer token for the install endpoint (overrides env INSTALL_TOKEN). */
  readonly installToken?: string;
  /** .cap URL installed at startup (overrides env PACKAGE_URL). */
  readonly packageUrl?: string;
  /** Mount path prefix (overrides env PATH_PREFIX); default `/`. */
  readonly pathPrefix?: string;
  /** Cache-Control default for static resources (route headers override). */
  readonly cacheControl?: string;
  /** Cache API store override (defaults to `caches.default`). */
  readonly cache?: Cache;
}

function jsonResponse(status: number, value: unknown, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

/** The global Cache API default store, typed beyond the DOM lib. */
function defaultCache(): Cache {
  const cacheStorage = (globalThis as { caches?: CacheStorage & { default?: Cache } }).caches;
  if (cacheStorage?.default === undefined) {
    throw new Error('Cache API (caches.default) is not available in this environment');
  }
  return cacheStorage.default;
}

/** Parse `Authorization: Bearer <token>`; null when absent or malformed. */
function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization');
  if (header === null) {
    return null;
  }
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1] ?? null;
}

export function createWorker(options: CreateWorkerOptions = {}): CapsiumWorker {
  const store = new CachePackageStore(
    options.cache ?? defaultCache(),
    new WebCryptoHashProvider(),
    new WebCryptoSignatureProvider(),
  );

  /**
   * One-time per-isolate init: restore the persisted install, then (when
   * still empty and a package URL is configured) fetch+install at startup.
   */
  let initPromise: Promise<InstalledPackage | undefined> | undefined;
  function initialize(env: CapsiumWorkerEnv): Promise<InstalledPackage | undefined> {
    initPromise ??= (async () => {
      const restored = await store.restore();
      if (restored !== undefined) {
        return restored;
      }
      const packageUrl = options.packageUrl ?? env.PACKAGE_URL;
      if (packageUrl !== undefined) {
        try {
          const response = await fetch(packageUrl);
          if (response.ok) {
            return await store.install(new Uint8Array(await response.arrayBuffer()));
          }
          console.error(`startup package fetch failed: HTTP ${response.status} (${packageUrl})`);
        } catch (error) {
          console.error(`startup package install failed: ${String(error)}`);
        }
      }
      return undefined;
    })();
    return initPromise;
  }

  async function handleInstall(request: Request, env: CapsiumWorkerEnv): Promise<Response> {
    if (request.method !== 'POST') {
      return jsonResponse(
        405,
        { error: `method ${request.method} not allowed for ${INSTALL_PATH}` },
        { Allow: 'POST' },
      );
    }
    const installToken = options.installToken ?? env.INSTALL_TOKEN;
    if (installToken !== undefined) {
      const presented = bearerToken(request);
      if (presented === null) {
        return jsonResponse(
          401,
          { error: 'install requires Authorization: Bearer <INSTALL_TOKEN>' },
          { 'WWW-Authenticate': 'Bearer realm="capsium"' },
        );
      }
      if (presented !== installToken) {
        return jsonResponse(403, { error: 'invalid install token' });
      }
    }
    let capBytes: Uint8Array;
    try {
      capBytes = new Uint8Array(await request.arrayBuffer());
    } catch {
      return jsonResponse(400, { error: 'cannot read request body' });
    }
    if (capBytes.length === 0) {
      return jsonResponse(400, { error: 'empty request body (expected a .cap archive)' });
    }
    try {
      const installed = await store.install(capBytes);
      return jsonResponse(200, {
        ok: true,
        name: installed.model.metadata.name,
        version: installed.model.metadata.version,
        contentHash: installed.contentHash,
      });
    } catch (error) {
      if (error instanceof InstallRejection) {
        return jsonResponse(error.status, { error: error.message });
      }
      console.error(`install failed: ${String(error)}`);
      return jsonResponse(500, { error: 'internal install error' });
    }
  }

  return {
    async fetch(request, env, _ctx) {
      await initialize(env);

      const rawPathname = new URL(request.url).pathname;
      const pathPrefix = options.pathPrefix ?? env.PATH_PREFIX ?? '/';
      const pathname = stripScopePrefix(rawPathname, pathPrefix);
      if (pathname === null) {
        // Outside the mount prefix — not this reactor's to serve.
        return jsonResponse(404, { error: `no route for ${rawPathname}` });
      }

      if (pathname === INSTALL_PATH) {
        return await handleInstall(request, env);
      }

      const method = request.method.toUpperCase();
      const pipeline = new ServingPipeline(
        store.current,
        options.cacheControl ?? DEFAULT_CACHE_CONTROL,
      );
      const response = pipeline.serve(pathname, method);
      // HEAD: status and headers (incl. Content-Length) without a body.
      return method === 'HEAD'
        ? new Response(null, { status: response.status, headers: response.headers })
        : response;
    },
  };
}
