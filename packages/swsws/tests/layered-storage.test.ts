import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity, TOMBSTONES_FILE } from '@capsium/core';
import { handleRequest } from '../src/fetch-handler.js';
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
  name: 'layered-pkg',
  version: '1.0.0',
  description: 'Layered storage fixture',
  guid: 'https://example.com/layered-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

const storage = {
  storage: {
    dataSets: { animals: { source: 'data/animals.json' } },
    layers: [
      { path: 'base', writable: false, visibility: 'exported' },
      { path: 'updates', writable: true, visibility: 'private' },
    ],
  },
};

const routes = {
  index: 'content/index.html',
  routes: [
    { path: '/', resource: 'content/index.html' },
    { path: '/about', resource: 'content/about.html' },
    { path: '/gone', resource: 'content/gone.html' },
    { path: '/api/v1/data/animals', dataset: 'animals' },
  ],
};

function fixtureFiles(tombstone = false): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>([
    ['metadata.json', json(metadata)],
    ['storage.json', json(storage)],
    ['routes.json', json(routes)],
    ['base/index.html', text('<h1>base index</h1>')],
    ['base/about.html', text('<h1>base about</h1>')],
    ['base/gone.html', text('<h1>gone</h1>')],
    ['updates/about.html', text('<h1>updated about</h1>')],
    ['data/animals.json', json([{ name: 'fox' }])],
  ]);
  if (tombstone) {
    files.set(`updates/${TOMBSTONES_FILE}`, json(['gone.html']));
  }
  return files;
}

async function storeWith(files: Map<string, Uint8Array>): Promise<PackageStore> {
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  const security = await buildSecurity(files, hashProvider);
  const out = new Map(files);
  out.set('security.json', json(security));
  await store.install(zipSync(Object.fromEntries(out)));
  return store;
}

async function get(store: PackageStore, path: string): Promise<Response> {
  return await handleRequest(new Request(`http://reactor.local${path}`), store);
}

describe('layered storage serving (§5a)', () => {
  it('serves files only present in a lower layer', async () => {
    const response = await get(await storeWith(fixtureFiles()), '/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>base index</h1>');
  });

  it('top layer wins when both layers have the file', async () => {
    const response = await get(await storeWith(fixtureFiles()), '/about');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>updated about</h1>');
  });

  it('dataset sources are package files and bypass the layers', async () => {
    const response = await get(await storeWith(fixtureFiles()), '/api/v1/data/animals');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ name: 'fox' }]);
  });

  it('tombstoned paths answer 404 even though a lower layer has the file', async () => {
    const store = await storeWith(fixtureFiles(true));
    const response = await get(store, '/gone');
    expect(response.status).toBe(404);
    // Non-tombstoned paths are unaffected.
    expect((await get(store, '/')).status).toBe(200);
  });
});
