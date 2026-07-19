import { describe, expect, it, vi } from 'vitest';
import { zipSync } from 'fflate';
import { buildSecurity } from '@capsium/core';
import { handleRequest } from '../src/fetch-handler.js';
import { HandlerExecutor, type SourceImporter } from '../src/handler-executor.js';
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
  name: 'handler-pkg',
  version: '1.0.0',
  description: 'Handler fixture',
  guid: 'https://example.com/handler-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

const route = { path: '/api/v1/echo', method: 'POST', handler: 'content/handlers/echo.js' };

function fixtureFiles(handlerSource: string, handlerPath = 'content/handlers/echo.js') {
  return new Map<string, Uint8Array>([
    ['metadata.json', json(metadata)],
    [
      'routes.json',
      json({ routes: [{ ...route, handler: handlerPath }] }),
    ],
    [handlerPath, text(handlerSource)],
    ['content/index.html', text('<!doctype html><h1>Handlers</h1>')],
  ]);
}

async function storeWith(files: Map<string, Uint8Array>): Promise<PackageStore> {
  const store = new PackageStore(new MemoryBlobCache(), hashProvider);
  const security = await buildSecurity(files, hashProvider);
  const out = new Map(files);
  out.set('security.json', json(security));
  await store.install(zipSync(Object.fromEntries(out)));
  return store;
}

describe('HandlerExecutor (mocked module loader)', () => {
  const routeOf = (handler: string) => ({ path: '/api/v1/x', method: 'GET', handler });

  it('calls the default export with the Request and returns its Response (async)', async () => {
    const entry = vi.fn(async (request: Request) => new Response(`url:${request.url}`));
    const importSource: SourceImporter = async () => ({ default: entry });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('export default null')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('url:http://sw.local/x');
    expect(entry).toHaveBeenCalledOnce();
  });

  it('supports a synchronous default export', async () => {
    const importSource: SourceImporter = async () => ({
      default: (request: Request) => new Response(`method:${request.method}`),
    });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x', { method: 'DELETE' }),
      files,
    );
    expect(await response.text()).toBe('method:DELETE');
  });

  it('falls back to a named fetch export', async () => {
    const importSource: SourceImporter = async () => ({
      fetch: () => new Response('from-fetch'),
    });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(await response.text()).toBe('from-fetch');
  });

  it('caches imported modules per handler path', async () => {
    const importSource = vi.fn(async () => ({ default: () => new Response('ok') }));
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    for (let i = 0; i < 3; i += 1) {
      const response = await executor.execute(
        routeOf('handlers/x.js'),
        new Request('http://sw.local/x'),
        files,
      );
      expect(response.status).toBe(200);
    }
    expect(importSource).toHaveBeenCalledOnce();
  });

  it('answers 502 when the handler file is missing from the package', async () => {
    const executor = new HandlerExecutor(async () => ({}));
    const response = await executor.execute(
      routeOf('handlers/missing.js'),
      new Request('http://sw.local/x'),
      new Map(),
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('handlers/missing.js');
  });

  it('answers 502 with a clear body when the import fails', async () => {
    const importSource: SourceImporter = async () => {
      throw new SyntaxError('Unexpected token');
    };
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('not javascript!!!')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('Unexpected token');
  });

  it('answers 502 when the module has no callable entry export', async () => {
    const importSource: SourceImporter = async () => ({ answer: 42 });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('no callable default/fetch export');
  });

  it('answers 500 when the handler throws', async () => {
    const importSource: SourceImporter = async () => ({
      default: () => {
        throw new Error('boom');
      },
    });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('boom');
  });

  it('answers 502 when the handler does not return a Response', async () => {
    const importSource: SourceImporter = async () => ({ default: () => 'plain string' });
    const executor = new HandlerExecutor(importSource);
    const files = new Map([['handlers/x.js', text('')]]);
    const response = await executor.execute(
      routeOf('handlers/x.js'),
      new Request('http://sw.local/x'),
      files,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('did not return a Response');
  });
});

describe('handleRequest handler execution (mocked loader)', () => {
  it('executes a JS handler route on method match', async () => {
    const store = await storeWith(fixtureFiles('export default null;'));
    const importSource: SourceImporter = async () => ({
      default: async (request: Request) =>
        new Response(`echo:${request.method}:${await request.text()}`),
    });
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST', body: 'ping' }),
      store,
      { importSource },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('echo:POST:ping');
  });

  it('answers 405 with Allow when the method does not match a JS handler', async () => {
    const store = await storeWith(fixtureFiles('export default null;'));
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'GET' }),
      store,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
  });
});

describe('handleRequest handler execution (real dynamic import via data: URL)', () => {
  // Node cannot import blob: URLs, so the default loader falls back to
  // data: URLs here; in the service worker the same code imports blob:.
  it('imports and executes the handler module from the package', async () => {
    const store = await storeWith(
      fixtureFiles(
        'export default async (request) => new Response("hello " + request.method);',
      ),
    );
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST' }),
      store,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('hello POST');
  });

  it('supports request bodies and named fetch exports', async () => {
    const store = await storeWith(
      fixtureFiles('export const fetch = async (request) => new Response(await request.text());'),
    );
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST', body: 'pong' }),
      store,
    );
    expect(await response.text()).toBe('pong');
  });

  it('answers 502 for a module with a syntax error', async () => {
    const store = await storeWith(fixtureFiles('export default (broken'));
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST' }),
      store,
    );
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('failed to import handler module');
  });

  it('answers 500 when the imported handler rejects', async () => {
    const store = await storeWith(
      fixtureFiles('export default async () => { throw new Error("kaboom"); };'),
    );
    const response = await handleRequest(
      new Request('http://reactor.local/api/v1/echo', { method: 'POST' }),
      store,
    );
    expect(response.status).toBe(500);
    expect(await response.text()).toContain('kaboom');
  });
});
