/**
 * Real worker-environment tests: the bundled default worker (tsup, all
 * deps inlined — the same artifact wrangler deploys) runs under miniflare
 * (workerd), fixtures are installed over HTTP and served back.
 */
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Miniflare } from 'miniflare';
import { WORKER_BUNDLE } from './bundle-path.js';
import {
  ABOUT_HTML,
  ANIMALS_JSON,
  generateSigningKeys,
  INDEX_HTML,
  LAYERED_INDEX_HTML,
  layeredCap,
  mainCap,
  mainFixtureFiles,
  packCap,
  signedCap,
} from './fixtures.js';

const COMPATIBILITY_DATE = '2025-09-01';
const TOKEN = 'test-install-token';

/** miniflare's dispatch response (undici-flavored, not the DOM type). */
type DispatchResponse = Awaited<ReturnType<Miniflare['dispatchFetch']>>;

function makeWorker(bindings?: Record<string, string>): Miniflare {
  return new Miniflare({
    modules: true,
    scriptPath: WORKER_BUNDLE,
    compatibilityDate: COMPATIBILITY_DATE,
    ...(bindings !== undefined ? { bindings } : {}),
  });
}

async function install(
  mf: Miniflare,
  cap: Uint8Array,
  options: { token?: string; prefix?: string } = {},
): Promise<DispatchResponse> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) {
    headers['Authorization'] = `Bearer ${options.token}`;
  }
  return await mf.dispatchFetch(`http://localhost${options.prefix ?? ''}/__capsium/install`, {
    method: 'POST',
    headers,
    body: cap,
  });
}

const workers: Miniflare[] = [];
function tracked(mf: Miniflare): Miniflare {
  workers.push(mf);
  return mf;
}

afterAll(async () => {
  await Promise.all(workers.map((mf) => mf.dispose()));
});

describe('install flow (INSTALL_TOKEN configured)', () => {
  let mf: Miniflare;
  let cap: Uint8Array;
  let installResponse: DispatchResponse;

  beforeAll(async () => {
    cap = await mainCap();
    mf = tracked(makeWorker({ INSTALL_TOKEN: TOKEN }));
    installResponse = await install(mf, cap, { token: TOKEN });
  });

  it('installs a verified package with a typed success body', async () => {
    expect(installResponse.status).toBe(200);
    expect(installResponse.headers.get('content-type')).toContain('application/json');
    const body = (await installResponse.json()) as Record<string, unknown>;
    expect(body['ok']).toBe(true);
    expect(body['name']).toBe('cf-demo-pkg');
    expect(body['version']).toBe('1.0.0');
    expect(body['contentHash']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects install without an Authorization header (401)', async () => {
    const response = await install(mf, cap);
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('Bearer');
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  it('rejects install with a wrong token (403)', async () => {
    const response = await install(mf, cap, { token: 'wrong' });
    expect(response.status).toBe(403);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });

  it('answers other methods on the install endpoint with 405 + Allow', async () => {
    const response = await mf.dispatchFetch('http://localhost/__capsium/install', {
      method: 'GET',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('POST');
  });

  it('rejects a tampered package (422) naming the checksum mismatch', async () => {
    const bad = await packCap(mainFixtureFiles(), true);
    const response = await install(mf, bad, { token: TOKEN });
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/integrity verification failed/);
    expect(body['error']).toMatch(/checksum-mismatch: content\/index\.html/);
    // The previously installed package is untouched by the rejected install.
    const index = await mf.dispatchFetch('http://localhost/');
    expect(index.status).toBe(200);
  });

  it('rejects a malformed (non-zip) body with 400', async () => {
    const response = await install(mf, new TextEncoder().encode('not a zip'), { token: TOKEN });
    expect(response.status).toBe(400);
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body['error']).toBe('string');
  });
});

describe('serving flow (installed main package)', () => {
  let mf: Miniflare;
  let cap: Uint8Array;

  beforeAll(async () => {
    cap = await mainCap();
    mf = tracked(makeWorker({ INSTALL_TOKEN: TOKEN }));
    await install(mf, cap, { token: TOKEN });
  });

  it('serves the index route with manifest MIME and the default Cache-Control', async () => {
    const response = await mf.dispatchFetch('http://localhost/');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html');
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
    expect(await response.text()).toBe(INDEX_HTML);
  });

  it('serves dual HTML routes for the index', async () => {
    for (const path of ['/index', '/index.html']) {
      const response = await mf.dispatchFetch(`http://localhost${path}`);
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html');
      expect(await response.text()).toBe(INDEX_HTML);
    }
  });

  it('serves a second page on both of its dual routes', async () => {
    for (const path of ['/about', '/about.html']) {
      const response = await mf.dispatchFetch(`http://localhost${path}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(ABOUT_HTML);
    }
  });

  it('lets route-level headers override the Cache-Control default', async () => {
    const response = await mf.dispatchFetch('http://localhost/styles.css');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/css');
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('serves the dataset route as JSON', async () => {
    const response = await mf.dispatchFetch('http://localhost/api/v1/data/animals');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe(ANIMALS_JSON);
  });

  it('answers unknown paths with a JSON 404', async () => {
    const response = await mf.dispatchFetch('http://localhost/nope');
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/no route/);
  });

  it('enforces GET/HEAD only on resource routes (405 + Allow)', async () => {
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await mf.dispatchFetch('http://localhost/', { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('allow')).toBe('GET, HEAD');
      const body = (await response.json()) as Record<string, unknown>;
      expect(typeof body['error']).toBe('string');
    }
  });

  it('answers handler routes with 501', async () => {
    const response = await mf.dispatchFetch('http://localhost/api/hello');
    expect(response.status).toBe(501);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/handler route not executable/);
  });

  it('answers HEAD with GET headers and no body', async () => {
    const get = await mf.dispatchFetch('http://localhost/');
    const getBody = await get.text();
    const head = await mf.dispatchFetch('http://localhost/', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-type')).toBe('text/html');
    expect(head.headers.get('cache-control')).toBe('public, max-age=31536000');
    // The HEAD response carries the GET body's length (workerd normalizes
    // the GET wire response to chunked encoding, so compare against the body).
    expect(head.headers.get('content-length')).toBe(String(getBody.length));
    expect(await head.text()).toBe('');
  });

  it('serves all four §7 introspection endpoints with the exact shapes', async () => {
    const metadata = await mf.dispatchFetch('http://localhost/api/v1/introspect/metadata');
    expect(metadata.status).toBe(200);
    expect(await metadata.json()).toEqual({
      packages: [
        {
          name: 'cf-demo-pkg',
          version: '1.0.0',
          description: 'Cloudflare reactor fixture',
          author: 'Capsium',
        },
      ],
    });

    const routes = await mf.dispatchFetch('http://localhost/api/v1/introspect/routes');
    const routesBody = (await routes.json()) as {
      routes: [{ package: string; routes: { method: string; path: string }[] }];
    };
    expect(routesBody.routes[0]?.package).toBe('cf-demo-pkg');
    expect(routesBody.routes[0]?.routes).toContainEqual({ method: 'GET', path: '/about' });
    expect(routesBody.routes[0]?.routes).toContainEqual({
      method: 'GET',
      path: '/api/v1/data/animals',
    });
    expect(routesBody.routes[0]?.routes).toContainEqual({ method: 'GET', path: '/api/hello' });

    const hashes = await mf.dispatchFetch('http://localhost/api/v1/introspect/content-hashes');
    const expectedHash = createHash('sha256').update(cap).digest('hex');
    expect(await hashes.json()).toEqual({
      contentHashes: [{ package: 'cf-demo-pkg', hash: expectedHash }],
    });

    const validity = await mf.dispatchFetch('http://localhost/api/v1/introspect/content-validity');
    const validityBody = (await validity.json()) as {
      contentValidity: { package: string; valid: boolean; lastChecked: string }[];
    };
    expect(validityBody.contentValidity).toHaveLength(1);
    expect(validityBody.contentValidity[0]?.package).toBe('cf-demo-pkg');
    expect(validityBody.contentValidity[0]?.valid).toBe(true);
    expect(validityBody.contentValidity[0]?.lastChecked).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
  });

  it('enforces GET/HEAD on the introspection endpoints too', async () => {
    const response = await mf.dispatchFetch('http://localhost/api/v1/introspect/metadata', {
      method: 'POST',
    });
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
  });
});

describe('signature verification (§6a)', () => {
  let mf: Miniflare;

  beforeAll(() => {
    mf = tracked(makeWorker()); // open install (no token): development mode
  });

  it('installs a correctly signed package', async () => {
    const keys = generateSigningKeys();
    const response = await install(mf, await signedCap(keys));
    expect(response.status).toBe(200);
    const index = await mf.dispatchFetch('http://localhost/');
    expect(index.status).toBe(200);
  });

  it('rejects a package whose signature does not verify (422)', async () => {
    const keys = generateSigningKeys();
    const response = await install(mf, await signedCap(keys, true));
    expect(response.status).toBe(422);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/signature verification failed/);
  });
});

describe('layered storage and reinstall', () => {
  let mf: Miniflare;

  beforeAll(() => {
    mf = tracked(makeWorker());
  });

  it('serves §5a layers and answers tombstoned paths with 404', async () => {
    expect((await install(mf, await layeredCap())).status).toBe(200);
    const index = await mf.dispatchFetch('http://localhost/');
    expect(index.status).toBe(200);
    expect(await index.text()).toBe(LAYERED_INDEX_HTML);
    const legacy = await mf.dispatchFetch('http://localhost/legacy');
    expect(legacy.status).toBe(404);
    const body = (await legacy.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/deleted/);
  });

  it('clears the previous package keys on reinstall', async () => {
    expect((await install(mf, await mainCap())).status).toBe(200);
    expect((await mf.dispatchFetch('http://localhost/about')).status).toBe(200);
    expect((await install(mf, await layeredCap())).status).toBe(200);
    // The layered package has no /about route and its keys replaced the old ones.
    expect((await mf.dispatchFetch('http://localhost/about')).status).toBe(404);
    const index = await mf.dispatchFetch('http://localhost/');
    expect(await index.text()).toBe(LAYERED_INDEX_HTML);
  });
});

describe('empty state', () => {
  let mf: Miniflare;

  beforeAll(() => {
    mf = tracked(makeWorker());
  });

  it('answers package routes with a JSON 404 before any install', async () => {
    const response = await mf.dispatchFetch('http://localhost/');
    expect(response.status).toBe(404);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body['error']).toMatch(/no Capsium package installed/);
  });

  it('answers introspection with empty list shapes before any install', async () => {
    const metadata = await mf.dispatchFetch('http://localhost/api/v1/introspect/metadata');
    expect(await metadata.json()).toEqual({ packages: [] });
    const hashes = await mf.dispatchFetch('http://localhost/api/v1/introspect/content-hashes');
    expect(await hashes.json()).toEqual({ contentHashes: [] });
  });
});

describe('scope prefix (PATH_PREFIX)', () => {
  let mf: Miniflare;

  beforeAll(async () => {
    mf = tracked(makeWorker({ PATH_PREFIX: '/docs' }));
    await install(mf, await mainCap(), { prefix: '/docs' });
  });

  it('serves package routes under the prefix', async () => {
    const response = await mf.dispatchFetch('http://localhost/docs/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    const about = await mf.dispatchFetch('http://localhost/docs/about');
    expect(about.status).toBe(200);
  });

  it('serves introspection under the prefix', async () => {
    const response = await mf.dispatchFetch('http://localhost/docs/api/v1/introspect/metadata');
    expect(response.status).toBe(200);
    const body = (await response.json()) as { packages: { name: string }[] };
    expect(body.packages[0]?.name).toBe('cf-demo-pkg');
  });

  it('does not serve requests outside the prefix', async () => {
    for (const path of ['/', '/about', '/api/v1/introspect/metadata']) {
      const response = await mf.dispatchFetch(`http://localhost${path}`);
      expect(response.status).toBe(404);
    }
  });
});

describe('startup install (PACKAGE_URL)', () => {
  let server: Server;
  let mf: Miniflare;

  beforeAll(async () => {
    const cap = await mainCap();
    server = createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.capsium.package' });
      res.end(cap);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address() as AddressInfo;
    mf = tracked(makeWorker({ PACKAGE_URL: `http://127.0.0.1:${port}/fixture.cap` }));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('fetches and installs the package on the first request', async () => {
    const response = await mf.dispatchFetch('http://localhost/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(INDEX_HTML);
    const metadata = await mf.dispatchFetch('http://localhost/api/v1/introspect/metadata');
    const body = (await metadata.json()) as { packages: { name: string }[] };
    expect(body.packages[0]?.name).toBe('cf-demo-pkg');
  });
});
