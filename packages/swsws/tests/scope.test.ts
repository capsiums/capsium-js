import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity } from '@capsium/core';
import { handleRequest, type HandleRequestOptions } from '../src/fetch-handler.js';
import { PackageStore, type KeyValueBlobCache } from '../src/package-store.js';
import { WebCryptoHashProvider } from '../src/webcrypto-hash-provider.js';
import { joinScopePrefix, stripScopePrefix } from '../src/scope.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

class MemoryBlobCache implements KeyValueBlobCache {
  private readonly blobs = new Map<string, Uint8Array>();

  put(key: string, data: Uint8Array): Promise<void> {
    this.blobs.set(key, data);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.blobs.get(key));
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}

const hashProvider = new WebCryptoHashProvider();

const SCOPE = '/playground/~serve/';

const metadata = {
  name: 'demo-pkg',
  version: '1.0.0',
  description: 'SW fixture',
  guid: 'https://example.com/demo-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

async function installedStore(
  extra: Map<string, Uint8Array> = new Map(),
): Promise<PackageStore> {
  const files = new Map([
    ['metadata.json', json(metadata)],
    ['storage.json', json({ storage: { dataSets: { animals: { source: 'data/animals.json' } } } })],
    ['content/index.html', text('<!doctype html><h1>Demo</h1>')],
    ['data/animals.json', json([{ name: 'fox' }])],
    ...extra,
  ]);
  const security = await buildSecurity(files, hashProvider);
  files.set('security.json', json(security));
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  await store.install(zipSync(Object.fromEntries(files)));
  return store;
}

describe('stripScopePrefix', () => {
  it('is the identity at root scope', () => {
    expect(stripScopePrefix('/', '/')).toBe('/');
    expect(stripScopePrefix('/api/v1/introspect/metadata', '/')).toBe(
      '/api/v1/introspect/metadata',
    );
  });

  it('strips a non-root prefix, mapping the scope root to /', () => {
    expect(stripScopePrefix('/playground/~serve/', SCOPE)).toBe('/');
    expect(stripScopePrefix('/playground/~serve', SCOPE)).toBe('/');
    expect(stripScopePrefix('/playground/~serve/about', SCOPE)).toBe('/about');
    expect(stripScopePrefix('/playground/~serve/api/v1/introspect/routes', SCOPE)).toBe(
      '/api/v1/introspect/routes',
    );
  });

  it('returns null outside the prefix, including look-alike boundaries', () => {
    expect(stripScopePrefix('/', SCOPE)).toBeNull();
    expect(stripScopePrefix('/playground', SCOPE)).toBeNull();
    expect(stripScopePrefix('/playground/~serve-other/page', SCOPE)).toBeNull();
  });
});

describe('joinScopePrefix', () => {
  it('is the identity at root scope', () => {
    expect(joinScopePrefix('/', '/auth/callback')).toBe('/auth/callback');
  });

  it('prefixes a package-relative path', () => {
    expect(joinScopePrefix(SCOPE, '/auth/callback')).toBe('/playground/~serve/auth/callback');
    expect(joinScopePrefix('/playground/~serve', '/')).toBe('/playground/~serve/');
  });
});

describe('handleRequest with a non-root scopePrefix', () => {
  const scoped: HandleRequestOptions = { scopePrefix: SCOPE };

  it('serves package routes relative to the prefix', async () => {
    const store = await installedStore();
    for (const path of ['/playground/~serve/', '/playground/~serve/index']) {
      const response = await handleRequest(new Request(`http://reactor.local${path}`), store, scoped);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<!doctype html><h1>Demo</h1>');
    }
  });

  it('serves dataset routes relative to the prefix', async () => {
    const store = await installedStore();
    const response = await handleRequest(
      new Request('http://reactor.local/playground/~serve/api/v1/data/animals'),
      store,
      scoped,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ name: 'fox' }]);
  });

  it('answers the §7 introspection endpoints under the prefix', async () => {
    const store = await installedStore();
    const response = await handleRequest(
      new Request('http://reactor.local/playground/~serve/api/v1/introspect/metadata'),
      store,
      scoped,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      packages: [{ name: 'demo-pkg', version: '1.0.0', description: 'SW fixture' }],
    });
  });

  it('does not serve requests outside the prefix', async () => {
    const store = await installedStore();
    for (const path of ['/', '/index', '/api/v1/data/animals', '/api/v1/introspect/metadata']) {
      const response = await handleRequest(new Request(`http://reactor.local${path}`), store, scoped);
      expect(response.status).toBe(404);
    }
  });

  it('behaves identically to before when no scopePrefix is given (root scope)', async () => {
    const store = await installedStore();
    const response = await handleRequest(new Request('http://reactor.local/'), store);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<!doctype html><h1>Demo</h1>');
  });
});

describe('oauth2 redirects with a non-root scopePrefix', () => {
  const deployConfig = { sessionSecret: 'deploy-time-secret' };
  const oauth2Config = {
    authentication: {
      oauth2: {
        enabled: true,
        provider: 'example',
        clientId: 'client-123',
        authorizationUrl: 'https://accounts.example.com/authorize',
        tokenUrl: 'https://accounts.example.com/token',
        redirectPath: '/auth/callback',
      },
    },
  };

  function mockProvider(): { fetchFn: typeof fetch; calls: Array<{ url: string; body?: string }> } {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url === 'https://accounts.example.com/token') {
        return new Response(JSON.stringify({ access_token: 'at-123' }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it('points redirect_uri inside the scope and returns there after the callback', async () => {
    const store = await installedStore(
      new Map([['authentication.json', json(oauth2Config)]]),
    );
    const { fetchFn, calls } = mockProvider();
    const options: HandleRequestOptions = { deployConfig, fetchFn, scopePrefix: SCOPE };

    const begin = await handleRequest(
      new Request('http://reactor.local/playground/~serve/'),
      store,
      options,
    );
    expect(begin.status).toBe(302);
    const location = new URL(begin.headers.get('Location') ?? '');
    expect(location.searchParams.get('redirect_uri')).toBe(
      'http://reactor.local/playground/~serve/auth/callback',
    );
    const state = location.searchParams.get('state') ?? '';

    const callback = await handleRequest(
      new Request(`http://reactor.local/playground/~serve/auth/callback?code=code-1&state=${state}`),
      store,
      options,
    );
    expect(callback.status).toBe(302);
    // returnTo keeps the scope prefix: the browser lands back inside the scope.
    expect(callback.headers.get('Location')).toBe('/playground/~serve/');

    const tokenCall = calls.find((call) => call.url === 'https://accounts.example.com/token');
    const params = new URLSearchParams(tokenCall?.body);
    expect(params.get('redirect_uri')).toBe(
      'http://reactor.local/playground/~serve/auth/callback',
    );
  });
});

describe('service worker fetch event with a non-root registration scope', () => {
  interface FetchEventMock {
    request: Request;
    responded: Promise<Response> | undefined;
    respondWith(response: Promise<Response>): void;
  }

  function fetchEvent(request: Request): FetchEventMock {
    const event: FetchEventMock = {
      request,
      responded: undefined,
      respondWith(response: Promise<Response>) {
        event.responded = response;
      },
    };
    return event;
  }

  /** The response the worker produced, asserting it did respond. */
  function responseOf(event: FetchEventMock): Promise<Response> {
    expect(event.responded).toBeDefined();
    return event.responded as Promise<Response>;
  }

  // The worker module registers its listeners once at import; share that
  // single registration across the tests in this describe.
  let workerPromise: Promise<(event: FetchEventMock) => void> | undefined;

  function loadWorker(): Promise<(event: FetchEventMock) => void> {
    workerPromise ??= (async () => {
      const listeners = new Map<string, (event: never) => void>();
      const globals = globalThis as Record<string, unknown>;
      globals.self = {
        registration: { scope: `https://reactor.local${SCOPE}` },
        location: { origin: 'https://reactor.local' },
        skipWaiting: () => Promise.resolve(),
        clients: { claim: () => Promise.resolve() },
        addEventListener: (type: string, listener: (event: never) => void) => {
          listeners.set(type, listener);
        },
      };
      globals.caches = {
        open: () =>
          Promise.resolve({
            match: () => Promise.resolve(undefined),
            put: () => Promise.resolve(),
            delete: () => Promise.resolve(),
          }),
      };
      await import('../src/sw.js');
      const listener = listeners.get('fetch');
      expect(listener).toBeDefined();
      return listener as (event: FetchEventMock) => void;
    })();
    return workerPromise;
  }

  it('answers introspection under the scope prefix', async () => {
    const onFetch = await loadWorker();
    const event = fetchEvent(
      new Request('https://reactor.local/playground/~serve/api/v1/introspect/metadata'),
    );
    onFetch(event);
    const response = await responseOf(event);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ packages: [] });
  });

  it('falls through to the network inside the scope when nothing is installed', async () => {
    const onFetch = await loadWorker();
    const fetchMock = vi.fn(() => Promise.resolve(new Response('from network')));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const event = fetchEvent(new Request('https://reactor.local/playground/~serve/about'));
      onFetch(event);
      expect(await (await responseOf(event)).text()).toBe('from network');
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not respond to requests outside the scope', async () => {
    const onFetch = await loadWorker();
    for (const path of ['/', '/about', '/api/v1/introspect/metadata']) {
      const event = fetchEvent(new Request(`https://reactor.local${path}`));
      onFetch(event);
      expect(event.responded).toBeUndefined();
    }
  });
});
