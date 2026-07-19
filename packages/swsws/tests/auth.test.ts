import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity } from '@capsium/core';
import { handleRequest, type HandleRequestOptions } from '../src/fetch-handler.js';
import { PackageStore, type KeyValueBlobCache } from '../src/package-store.js';
import { WebCryptoHashProvider } from '../src/webcrypto-hash-provider.js';

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

const metadata = {
  name: 'auth-pkg',
  version: '1.0.0',
  description: 'Auth fixture',
  guid: 'https://example.com/auth-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

const HTpasswd = 'alice:$apr1$eWvS2f3d$uvjLCQ9y6Om4aVryf5uSX.\n';

const basicAuthConfig = {
  authentication: { basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd', realm: 'capsium' } },
};

const oauth2Config = {
  authentication: {
    oauth2: {
      enabled: true,
      provider: 'example',
      clientId: 'client-123',
      authorizationUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      userinfoUrl: 'https://accounts.example.com/userinfo',
      redirectPath: '/auth/callback',
      scopes: ['openid', 'email'],
    },
  },
};

function filesWith(authentication: unknown, extra: Record<string, Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>([
    ['metadata.json', json(metadata)],
    ['authentication.json', json(authentication)],
    [
      'routes.json',
      json({
        routes: [
          { path: '/', resource: 'content/index.html' },
          {
            path: '/api/v1/data/animals',
            dataset: 'animals',
            accessControl: { authenticationRequired: true },
          },
          {
            path: '/api/v1/data/admin-only',
            dataset: 'animals',
            accessControl: { roles: ['admin'] },
          },
        ],
      }),
    ],
    ['storage.json', json({ storage: { dataSets: { animals: { source: 'data/animals.json' } } } })],
    ['content/index.html', text('<h1>private area</h1>')],
    ['data/animals.json', json([{ name: 'fox' }])],
    ...Object.entries(extra),
  ]);
  return files;
}

async function storeWith(
  files: Map<string, Uint8Array>,
  options: { install?: ReadonlyMap<string, Uint8Array> } = {},
): Promise<PackageStore> {
  void options;
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  const security = await buildSecurity(files, hashProvider);
  const out = new Map(files);
  out.set('security.json', json(security));
  await store.install(zipSync(Object.fromEntries(out)));
  return store;
}

function basic(user: string, password: string): string {
  return `Basic ${btoa(`${user}:${password}`)}`;
}

describe('basicAuth (§4b)', () => {
  it('challenges with 401 + WWW-Authenticate when unauthenticated', async () => {
    const store = await storeWith(filesWith(basicAuthConfig, { 'auth/.htpasswd': text(HTpasswd) }));
    const response = await handleRequest(new Request('http://reactor.local/'), store);
    expect(response.status).toBe(401);
    expect(response.headers.get('WWW-Authenticate')).toContain('Basic realm="capsium"');
  });

  it('rejects wrong credentials with 401', async () => {
    const store = await storeWith(filesWith(basicAuthConfig, { 'auth/.htpasswd': text(HTpasswd) }));
    const response = await handleRequest(
      new Request('http://reactor.local/', {
        headers: { Authorization: basic('alice', 'wrong') },
      }),
      store,
    );
    expect(response.status).toBe(401);
  });

  it('serves content with valid credentials', async () => {
    const store = await storeWith(filesWith(basicAuthConfig, { 'auth/.htpasswd': text(HTpasswd) }));
    const response = await handleRequest(
      new Request('http://reactor.local/', {
        headers: { Authorization: basic('alice', 'swordfish') },
      }),
      store,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>private area</h1>');
  });

  it('answers 501 with a precise body when the htpasswd file is missing', async () => {
    const store = await storeWith(filesWith(basicAuthConfig));
    const response = await handleRequest(
      new Request('http://reactor.local/', {
        headers: { Authorization: basic('alice', 'swordfish') },
      }),
      store,
    );
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('passwdFile missing');
  });

  it('answers 501 for unsupported htpasswd hash types', async () => {
    const store = await storeWith(
      filesWith(basicAuthConfig, {
        'auth/.htpasswd': text('carol:$6$rounds=5000$somesalt$SHA512cryptEntry\n'),
      }),
    );
    const response = await handleRequest(
      new Request('http://reactor.local/', {
        headers: { Authorization: basic('carol', 'swordfish') },
      }),
      store,
    );
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('sha-crypt');
  });

  it('role-restricted datasets answer 403 for role-less basic principals', async () => {
    const store = await storeWith(filesWith(basicAuthConfig, { 'auth/.htpasswd': text(HTpasswd) }));
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/data/admin-only', {
        headers: { Authorization: basic('alice', 'swordfish') },
      }),
      store,
    );
    expect(response.status).toBe(403);
  });
});

describe('oauth2 PKCE (§4b)', () => {
  const deployConfig = { sessionSecret: 'deploy-time-secret' };

  async function beginLogin(store: PackageStore, options: HandleRequestOptions) {
    const response = await handleRequest(new Request('http://reactor.local/'), store, options);
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get('Location') ?? '');
    return location;
  }

  function mockProvider(): { fetchFn: typeof fetch; calls: Array<{ url: string; body?: string }> } {
    const calls: Array<{ url: string; body?: string }> = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(typeof init?.body === 'string' ? { body: init.body } : {}) });
      if (url === 'https://accounts.example.com/token') {
        return new Response(JSON.stringify({ access_token: 'at-123' }), { status: 200 });
      }
      if (url === 'https://accounts.example.com/userinfo') {
        return new Response(JSON.stringify({ sub: 'user-1', roles: ['admin'] }), { status: 200 });
      }
      return new Response('not found', { status: 404 });
    }) as typeof fetch;
    return { fetchFn, calls };
  }

  it('redirects unauthenticated requests to the provider with PKCE params', async () => {
    const store = await storeWith(filesWith(oauth2Config));
    const { fetchFn } = mockProvider();
    const location = await beginLogin(store, { deployConfig, fetchFn });
    expect(location.origin).toBe('https://accounts.example.com');
    expect(location.pathname).toBe('/authorize');
    expect(location.searchParams.get('response_type')).toBe('code');
    expect(location.searchParams.get('client_id')).toBe('client-123');
    expect(location.searchParams.get('redirect_uri')).toBe('http://reactor.local/auth/callback');
    expect(location.searchParams.get('scope')).toBe('openid email');
    expect(location.searchParams.get('code_challenge_method')).toBe('S256');
    expect(location.searchParams.get('code_challenge')).toBeTruthy();
    expect(location.searchParams.get('state')).toBeTruthy();
  });

  it('completes the code exchange and opens a signed session', async () => {
    const store = await storeWith(filesWith(oauth2Config));
    const { fetchFn, calls } = mockProvider();
    const options: HandleRequestOptions = { deployConfig, fetchFn };

    const location = await beginLogin(store, options);
    const state = location.searchParams.get('state') ?? '';
    const callback = await handleRequest(
      new Request(`http://reactor.local/auth/callback?code=code-1&state=${state}`),
      store,
      options,
    );
    expect(callback.status).toBe(302);
    expect(callback.headers.get('Location')).toBe('/');
    const cookie = callback.headers.get('Set-Cookie') ?? '';
    expect(cookie).toContain('capsium_session=');
    expect(cookie).toContain('HttpOnly');

    // The token exchange sent the PKCE verifier to the token endpoint.
    const tokenCall = calls.find((call) => call.url === 'https://accounts.example.com/token');
    expect(tokenCall?.body).toContain('grant_type=authorization_code');
    expect(tokenCall?.body).toContain('code_verifier=');
    expect(tokenCall?.body).toContain('client_id=client-123');

    // The session cookie authenticates subsequent requests (roles from userinfo).
    const sessionCookie = (cookie.match(/capsium_session=([^;]+)/) ?? [])[1] ?? '';
    const authed = await handleRequest(
      new Request('http://reactor.local/api/v1/data/admin-only', {
        headers: { Cookie: `capsium_session=${sessionCookie}` },
      }),
      store,
      options,
    );
    expect(authed.status).toBe(200);

    // A tampered cookie does not authenticate.
    const forged = await handleRequest(
      new Request('http://reactor.local/', {
        headers: { Cookie: `capsium_session=${sessionCookie.slice(0, -1)}x` },
      }),
      store,
      options,
    );
    expect(forged.status).toBe(302); // treated as unauthenticated -> redirect
  });

  it('rejects callback requests with a bad state', async () => {
    const store = await storeWith(filesWith(oauth2Config));
    const { fetchFn } = mockProvider();
    const response = await handleRequest(
      new Request('http://reactor.local/auth/callback?code=code-1&state=bogus'),
      store,
      { deployConfig, fetchFn },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('state');
  });

  it('answers 501 with a precise body without a deploy-time session secret', async () => {
    const store = await storeWith(filesWith(oauth2Config));
    const response = await handleRequest(new Request('http://reactor.local/'), store);
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('deploy-time session secret');
  });
});

describe('accessControl without authentication.json', () => {
  it('answers 401 when authenticationRequired is set but no auth is configured', async () => {
    const files = filesWith(basicAuthConfig, { 'auth/.htpasswd': text(HTpasswd) });
    files.delete('authentication.json');
    const store = await storeWith(files);
    const open = await handleRequest(new Request('http://reactor.local/'), store);
    expect(open.status).toBe(200);
    const gated = await handleRequest(
      new Request('http://reactor.local/api/v1/data/animals'),
      store,
    );
    expect(gated.status).toBe(401);
  });
});
