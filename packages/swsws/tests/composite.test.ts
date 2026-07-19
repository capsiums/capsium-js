import { describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity } from '@capsium/core';
import { handleRequest } from '../src/fetch-handler.js';
import type { SourceImporter } from '../src/handler-executor.js';
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

const CORE_GUID = 'capsium://example.com/core';

const coreMetadata = {
  name: 'core',
  version: '1.4.1',
  description: 'Dependency package',
  guid: CORE_GUID,
  uuid: '123e4567-e89b-12d3-a456-4266141740aa',
};

const mainMetadata = {
  name: 'site',
  version: '2.0.0',
  description: 'Composite dependent package',
  guid: 'capsium://example.com/site',
  uuid: '123e4567-e89b-12d3-a456-4266141740bb',
  dependencies: { [CORE_GUID]: '>=1.0.0 <2.0.0' },
};

function coreFiles(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['metadata.json', json(coreMetadata)],
    [
      'manifest.json',
      json({
        resources: {
          'content/app.js': { type: 'text/javascript', visibility: 'exported' },
          'content/hello.txt': { type: 'text/plain', visibility: 'exported' },
          'content/secret.js': { type: 'text/javascript', visibility: 'private' },
          'content/handlers/dep.js': { type: 'text/javascript', visibility: 'exported' },
        },
      }),
    ],
    ['content/app.js', text('export const from = "core";')],
    ['content/hello.txt', text('hello from core')],
    ['content/secret.js', text('export const secret = 42;')],
    ['content/handlers/dep.js', text('export default null;')],
  ]);
}

const mainRoutes = {
  routes: [
    { path: '/', resource: 'content/index.html' },
    { path: '/vendor/app.js', resource: `${CORE_GUID}/content/app.js` },
    { path: '/vendor/secret.js', resource: `${CORE_GUID}/content/secret.js` },
    { path: '/vendor/missing.js', resource: `${CORE_GUID}/content/missing.js` },
    { path: '/vendor/unknown.js', resource: 'capsium://example.com/unknown/content/x.js' },
    {
      path: '/legacy/app.js',
      resource: `${CORE_GUID}/content/app.js`,
      remap: '/vendor/remapped.js',
    },
    {
      path: '/rewritten',
      resource: `${CORE_GUID}/content/hello.txt`,
      responseRewrite: { body: 'REWRITTEN', headers: { 'X-Rewrite': 'yes' } },
    },
    {
      path: '/enhanced',
      resource: `${CORE_GUID}/content/hello.txt`,
      responseHeaders: { 'X-Enhanced': '1', 'Content-Type': 'text/html' },
    },
    {
      path: '/local-enhanced',
      resource: 'content/local.txt',
      responseRewrite: { headers: { 'X-Local': 'on' } },
    },
    {
      path: '/api/dep',
      method: 'GET',
      handler: `${CORE_GUID}/content/handlers/dep.js`,
      requestHeaders: { 'X-Supplant': 'yes' },
    },
  ],
};

function mainFiles(): Map<string, Uint8Array> {
  return new Map<string, Uint8Array>([
    ['metadata.json', json(mainMetadata)],
    ['routes.json', json(mainRoutes)],
    ['content/index.html', text('<h1>site</h1>')],
    ['content/local.txt', text('local body')],
  ]);
}

async function pack(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  const security = await buildSecurity(files, hashProvider);
  const out = new Map(files);
  out.set('security.json', json(security));
  return zipSync(Object.fromEntries(out));
}

async function compositeStore(): Promise<PackageStore> {
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  await store.install(
    await pack(mainFiles()),
    new Map([[CORE_GUID, await pack(coreFiles())]]),
  );
  return store;
}

async function get(store: PackageStore, path: string): Promise<Response> {
  return await handleRequest(new Request(`http://reactor.local${path}`), store);
}

describe('composite packages (§4a): dependency resources', () => {
  it('serves an exported dependency resource through a capsium:// route', async () => {
    const response = await get(await compositeStore(), '/vendor/app.js');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('text/javascript');
    expect(await response.text()).toBe('export const from = "core";');
  });

  it('rejects references to a dependency private resource', async () => {
    const response = await get(await compositeStore(), '/vendor/secret.js');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('private');
  });

  it('404s missing dependency resources and unknown dependencies', async () => {
    const store = await compositeStore();
    expect((await get(store, '/vendor/missing.js')).status).toBe(404);
    const unknown = await get(store, '/vendor/unknown.js');
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toContain('dependency not installed');
  });

  it('404s dependency references when no dependency was supplied', async () => {
    const store = new PackageStore(new MemoryBlobCache(), hashProvider);
    await store.install(await pack(mainFiles()));
    expect((await get(store, '/vendor/app.js')).status).toBe(404);
  });

  it('serves the local package normally alongside inherited routes', async () => {
    const response = await get(await compositeStore(), '/');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('<h1>site</h1>');
  });
});

describe('composite packages (§4a): route inheritance attributes', () => {
  it('serves a remapped route at the remapped path only', async () => {
    const store = await compositeStore();
    const response = await get(store, '/vendor/remapped.js');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('export const from = "core";');
    expect((await get(store, '/legacy/app.js')).status).toBe(404);
  });

  it('responseRewrite replaces body and overrides headers', async () => {
    const response = await get(await compositeStore(), '/rewritten');
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('REWRITTEN');
    expect(response.headers.get('X-Rewrite')).toBe('yes');
  });

  it('responseHeaders are additive only (never override)', async () => {
    const response = await get(await compositeStore(), '/enhanced');
    expect(response.headers.get('X-Enhanced')).toBe('1');
    // Content-Type came from the dependency manifest and must not be overridden.
    expect(response.headers.get('Content-Type')).toBe('text/plain');
  });

  it('inheritance processing also applies to local resources', async () => {
    const response = await get(await compositeStore(), '/local-enhanced');
    expect(await response.text()).toBe('local body');
    expect(response.headers.get('X-Local')).toBe('on');
  });

  it('requestHeaders are supplanted before forwarding to the handler', async () => {
    const importSource: SourceImporter = async () => ({
      default: (request: Request) =>
        new Response(`supplant:${request.headers.get('X-Supplant') ?? 'no'}`),
    });
    const store = await compositeStore();
    const response = await handleRequest(
      new Request('http://reactor.local/api/dep'),
      store,
      { importSource },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('supplant:yes');
  });
});

describe('composite install persistence', () => {
  it('restores the composite view after a worker restart', async () => {
    const blobs = new MemoryBlobCache();
    const first = new PackageStore(blobs, hashProvider);
    await first.install(await pack(mainFiles()), new Map([[CORE_GUID, await pack(coreFiles())]]));
    const second = new PackageStore(blobs, hashProvider);
    const restored = await second.restore();
    expect(restored?.model.metadata.name).toBe('site');
    expect(restored?.dependencies.get(CORE_GUID)?.model.metadata.name).toBe('core');
    const response = await get(second, '/vendor/app.js');
    expect(response.status).toBe(200);
  });
});
