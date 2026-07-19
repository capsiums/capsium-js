/**
 * swsws service worker entry: the browser Capsium reactor.
 *
 * - Receives a .cap blob from the page (postMessage), verifies its SHA-256
 *   checksums against security.json (§6), and persists it in the Cache API.
 * - Resolves fetch requests per routes.json (§4), serving bytes from the zip.
 * - Answers the §7 introspection endpoints under /api/v1/introspect/.
 *
 * Registered at a non-root scope (e.g. /playground/~serve/), package routes
 * are served relative to the scope's pathname prefix and requests outside
 * the scope are never answered; at root scope behavior is unchanged.
 */
/// <reference lib="webworker" />
import {
  CacheApiBlobCache,
  PackageIntegrityError,
  PackageSignatureError,
  PackageStore,
} from './package-store.js';
import { WebCryptoHashProvider } from './webcrypto-hash-provider.js';
import { WebCryptoSignatureProvider } from './webcrypto-signature-provider.js';
import { handleRequest } from './fetch-handler.js';
import { stripScopePrefix } from './scope.js';

declare const self: ServiceWorkerGlobalScope;

const CACHE_NAME = 'capsium-swsws';

/** Paths always served from the network (the demo page and this script). */
const PASSTHROUGH_PATHS: ReadonlySet<string> = new Set(['/sw.js', '/index.html']);

/** The pathname prefix this worker is registered under ('/' at root scope). */
const SCOPE_PREFIX = new URL(self.registration.scope).pathname;

let storePromise: Promise<PackageStore> | undefined;

/** Deploy-time configuration (§4b: secrets NEVER come from the package). */
interface DeployConfig {
  sessionSecret?: string;
}

let deployConfig: DeployConfig = {};

function getStore(): Promise<PackageStore> {
  storePromise ??= (async () => {
    const cache = await caches.open(CACHE_NAME);
    const store = new PackageStore(
      new CacheApiBlobCache(cache),
      new WebCryptoHashProvider(),
      new WebCryptoSignatureProvider(),
    );
    try {
      await store.restore();
    } catch (error) {
      console.error('stored package failed integrity verification, dropped:', error);
    }
    return store;
  })();
  return storePromise;
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data as
    | { type?: unknown; cap?: unknown; config?: unknown }
    | undefined;
  if (data?.type === 'deploy-config') {
    // §4b: deploy-time secrets (e.g. the session cookie signing secret for
    // OAuth2 packages) arrive from the page — never from the package.
    const config = data.config as DeployConfig | undefined;
    deployConfig =
      config !== undefined && typeof config.sessionSecret === 'string'
        ? { sessionSecret: config.sessionSecret }
        : {};
    event.source?.postMessage({ type: 'deploy-config-result', ok: true });
    return;
  }
  if (data?.type !== 'install-package' || !(data.cap instanceof ArrayBuffer)) {
    return;
  }
  const cap = data.cap;
  const source = event.source;
  event.waitUntil(
    (async () => {
      try {
        const installed = await (await getStore()).install(new Uint8Array(cap));
        source?.postMessage({
          type: 'install-result',
          ok: true,
          name: installed.model.metadata.name,
          version: installed.model.metadata.version,
        });
      } catch (error) {
        source?.postMessage({
          type: 'install-result',
          ok: false,
          error:
            error instanceof PackageIntegrityError || error instanceof PackageSignatureError
              ? error.message
              : `install failed: ${String(error)}`,
        });
      }
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || PASSTHROUGH_PATHS.has(url.pathname)) {
    return;
  }
  const pathname = stripScopePrefix(url.pathname, SCOPE_PREFIX);
  if (pathname === null) {
    // Outside the registration scope: never this worker's to serve.
    return;
  }
  event.respondWith(
    (async () => {
      const store = await getStore();
      if (store.current === undefined && !pathname.startsWith('/api/v1/')) {
        return fetch(event.request);
      }
      return await handleRequest(event.request, store, {
        deployConfig,
        scopePrefix: SCOPE_PREFIX,
      });
    })(),
  );
});

export {};
