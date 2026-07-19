import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity } from '@capsium/core';
import { handleRequest } from '../src/fetch-handler.js';
import {
  PackageIntegrityError,
  PackageStore,
  type KeyValueBlobCache,
} from '../src/package-store.js';
import { WebCryptoHashProvider } from '../src/webcrypto-hash-provider.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

/** Mocked Cache-API stand-in: the "mocked cache" the store persists to. */
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
  name: 'demo-pkg',
  version: '1.0.0',
  description: 'SW fixture',
  guid: 'https://example.com/demo-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json(metadata)],
    ['storage.json', json({ storage: { dataSets: { animals: { source: 'data/animals.json' } } } })],
    ['content/index.html', text('<!doctype html><h1>Demo</h1>')],
    ['data/animals.json', json([{ name: 'fox' }])],
  ]);
}

async function packCap(files: Map<string, Uint8Array>, tamper = false): Promise<Uint8Array> {
  const security = await buildSecurity(files, hashProvider);
  const out = new Map(files);
  out.set('security.json', json(security));
  if (tamper) {
    out.set('content/index.html', text('<h1>tampered</h1>'));
  }
  return zipSync(Object.fromEntries(out));
}

async function installedStore(): Promise<PackageStore> {
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  await store.install(await packCap(fixtureFiles()));
  return store;
}

describe('PackageStore', () => {
  it('installs a verified package and exposes its content hash', async () => {
    const store = await installedStore();
    expect(store.current?.model.metadata.name).toBe('demo-pkg');
    expect(store.current?.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.current?.validity.valid).toBe(true);
  });

  it('rejects a tampered package with PackageIntegrityError', async () => {
    const store = new PackageStore(new MemoryBlobCache(), hashProvider);
    await expect(store.install(await packCap(fixtureFiles(), true))).rejects.toThrow(
      PackageIntegrityError,
    );
    expect(store.current).toBeUndefined();
  });

  it('restores a previously persisted package from the cache', async () => {
    const blobs = new MemoryBlobCache();
    const first = new PackageStore(blobs, hashProvider);
    await first.install(await packCap(fixtureFiles()));
    const second = new PackageStore(blobs, hashProvider);
    const restored = await second.restore();
    expect(restored?.model.metadata.name).toBe('demo-pkg');
  });
});

describe('handleRequest', () => {
  it('serves / and /index as the index HTML (auto-generated dual routes)', async () => {
    const store = await installedStore();
    for (const path of ['/', '/index', '/index.html']) {
      const response = await handleRequest(new Request(`http://reactor.local${path}`), store);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('text/html');
      expect(await response.text()).toBe('<!doctype html><h1>Demo</h1>');
    }
  });

  it('serves dataset routes from data/', async () => {
    const store = await installedStore();
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/data/animals'),
      store,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/json');
    expect(await response.json()).toEqual([{ name: 'fox' }]);
  });

  it('404s unknown paths', async () => {
    const store = await installedStore();
    const response = await handleRequest(new Request('http://reactor.local/nope'), store);
    expect(response.status).toBe(404);
  });

  it('answers the §7 introspection endpoints', async () => {
    const store = await installedStore();
    const get = async (path: string) =>
      await (await handleRequest(new Request(`http://reactor.local${path}`), store)).json();

    expect(await get('/api/v1/introspect/metadata')).toEqual({
      packages: [{ name: 'demo-pkg', version: '1.0.0', description: 'SW fixture' }],
    });

    const routes = await get('/api/v1/introspect/routes');
    expect(routes.routes[0].package).toBe('demo-pkg');
    expect(routes.routes[0].routes).toContainEqual({ method: 'GET', path: '/' });

    const hashes = await get('/api/v1/introspect/content-hashes');
    expect(hashes.contentHashes[0].hash).toBe(store.current?.contentHash);

    const validity = await get('/api/v1/introspect/content-validity');
    expect(validity.contentValidity[0]).toMatchObject({ package: 'demo-pkg', valid: true });
  });

  it('answers introspection with empty lists when nothing is installed', async () => {
    const store = new PackageStore(new MemoryBlobCache(), hashProvider);
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/introspect/metadata'),
      store,
    );
    expect(await response.json()).toEqual({ packages: [] });
  });

  it('responds 501 for non-JS handler routes', async () => {
    const files = fixtureFiles();
    files.set(
      'routes.json',
      json({ routes: [{ path: '/api/v1/echo', method: 'POST', handler: 'handlers/echo.lua' }] }),
    );
    const store = new PackageStore(new MemoryBlobCache(), hashProvider);
    await store.install(await packCap(files));
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST' }),
      store,
    );
    expect(response.status).toBe(501);
    expect(await response.text()).toContain('not executable');
  });
});
