import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  contentHashesResponseSchema,
  contentValidityResponseSchema,
  introspectMetadataResponseSchema,
  introspectRoutesResponseSchema,
} from '@capsium/core';
import { CapArchive, PackageCipher, PackageReader, PackageWriter } from '@capsium/packager';
import {
  createReactor,
  DependencyResolutionError,
  EncryptedPackageError,
  PackageIntegrityError,
} from '../src/index.js';
import {
  cleanupFixtures,
  json,
  text,
  withServer,
  writePackageDir,
  writeTempFile,
} from './fixtures.js';

afterAll(cleanupFixtures);

/* ------------------------------------------------------------------ */
/* Package fixtures                                                    */
/* ------------------------------------------------------------------ */

const metadata = {
  name: 'demo-pkg',
  version: '1.0.0',
  description: 'Node reactor fixture',
  guid: 'https://example.com/demo-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  author: 'Ribose',
};

const storage = {
  storage: { dataSets: { animals: { source: 'data/animals.json' } } },
};

/** Basic package: manifest/routes auto-generated at load (dual index routes). */
function demoFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json(metadata)],
    ['storage.json', json(storage)],
    ['content/index.html', text('<!doctype html><h1>Demo</h1>')],
    ['content/styles.css', text('body { color: teal; }')],
    ['data/animals.json', json([{ name: 'fox' }])],
  ]);
}

/** Explicit routes: header overrides, a dataset route and a handler route. */
function customRoutesFiles(): Map<string, Uint8Array> {
  const files = demoFiles();
  files.set(
    'routes.json',
    json({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        {
          path: '/styles.css',
          resource: 'content/styles.css',
          headers: { 'Cache-Control': 'no-cache', 'X-Route': 'yes' },
        },
        { path: '/api/v1/data/animals', dataset: 'animals' },
        { path: '/api/echo', method: 'POST', handler: 'content/echo.js' },
      ],
    }),
  );
  files.set('content/echo.js', text('export default null;'));
  return files;
}

/* ------------------------------------------------------------------ */
/* Static resource + dataset serving                                   */
/* ------------------------------------------------------------------ */

describe('resource serving', () => {
  it('serves static resources with MIME type and default Cache-Control', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/styles.css');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/css');
      expect(response.headers.get('cache-control')).toBe('public, max-age=31536000');
      expect(response.headers.get('content-length')).toBe(String('body { color: teal; }'.length));
      expect(response.body).toBe('body { color: teal; }');
    });
  });

  it('serves the index HTML on /, /index and /index.html (dual routes)', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      for (const path of ['/', '/index', '/index.html']) {
        const response = await request(path);
        expect(response.status).toBe(200);
        expect(response.headers.get('content-type')).toBe('text/html');
        expect(response.body).toBe('<!doctype html><h1>Demo</h1>');
      }
    });
  });

  it('serves dataset routes as JSON', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/api/v1/data/animals');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(response.body)).toEqual([{ name: 'fox' }]);
    });
  });

  it('lets route-level headers override the Cache-Control default', async () => {
    const handler = await createReactor({ package: await writePackageDir(customRoutesFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/styles.css');
      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-cache');
      expect(response.headers.get('x-route')).toBe('yes');
      expect(response.headers.get('content-type')).toBe('text/css');
    });
  });

  it('honors the cacheControl option as the serving default', async () => {
    const handler = await createReactor({
      package: await writePackageDir(demoFiles()),
      cacheControl: 'no-store',
    });
    await withServer(handler, async (request) => {
      const response = await request('/styles.css');
      expect(response.headers.get('cache-control')).toBe('no-store');
    });
  });

  it('answers HEAD with headers only', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/', 'HEAD');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/html');
      expect(response.headers.get('content-length')).toBe(
        String('<!doctype html><h1>Demo</h1>'.length),
      );
      expect(response.body).toBe('');
    });
  });

  it('serves from a .cap archive path', async () => {
    const capBytes = await new PackageWriter().packFiles(demoFiles());
    const handler = await createReactor({ package: await writeTempFile(capBytes) });
    await withServer(handler, async (request) => {
      const response = await request('/');
      expect(response.status).toBe(200);
      expect(response.body).toBe('<!doctype html><h1>Demo</h1>');
    });
  });

  it('accepts an already-read PackageReader model', async () => {
    const model = await new PackageReader().readDirectory(await writePackageDir(demoFiles()));
    const handler = await createReactor({ package: model });
    await withServer(handler, async (request) => {
      const response = await request('/');
      expect(response.status).toBe(200);
      expect(response.body).toBe('<!doctype html><h1>Demo</h1>');
    });
  });
});

/* ------------------------------------------------------------------ */
/* Status codes                                                        */
/* ------------------------------------------------------------------ */

describe('status codes', () => {
  it('404s unknown paths within the package with a JSON body', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/nope');
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toBe('application/json');
      expect(JSON.parse(response.body)).toEqual({ error: 'no route for /nope' });
    });
  });

  it('405s non-GET/HEAD methods with an Allow header', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const created = await request('/', 'POST');
      expect(created.status).toBe(405);
      expect(created.headers.get('allow')).toBe('GET, HEAD');
      const introspected = await request('/api/v1/introspect/metadata', 'POST');
      expect(introspected.status).toBe(405);
      expect(introspected.headers.get('allow')).toBe('GET, HEAD');
    });
  });

  it('501s handler routes (not executed by this reactor)', async () => {
    const handler = await createReactor({ package: await writePackageDir(customRoutesFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/api/echo', 'POST');
      expect(response.status).toBe(501);
      expect(JSON.parse(response.body)).toEqual({
        error: 'handler route not executable by this reactor: content/echo.js',
      });
      // A method the handler route does not declare is 405 with its methods.
      const wrongMethod = await request('/api/echo', 'GET');
      expect(wrongMethod.status).toBe(405);
      expect(wrongMethod.headers.get('allow')).toBe('POST');
    });
  });
});

/* ------------------------------------------------------------------ */
/* §7 introspection                                                    */
/* ------------------------------------------------------------------ */

describe('introspection API (§7)', () => {
  it('reports package metadata', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/api/v1/introspect/metadata');
      expect(response.status).toBe(200);
      const body = introspectMetadataResponseSchema.parse(JSON.parse(response.body));
      expect(body).toEqual({
        packages: [
          {
            name: 'demo-pkg',
            version: '1.0.0',
            author: 'Ribose',
            description: 'Node reactor fixture',
          },
        ],
      });
    });
  });

  it('reports served routes', async () => {
    const handler = await createReactor({ package: await writePackageDir(demoFiles()) });
    await withServer(handler, async (request) => {
      const response = await request('/api/v1/introspect/routes');
      expect(response.status).toBe(200);
      const body = introspectRoutesResponseSchema.parse(JSON.parse(response.body));
      expect(body.routes).toHaveLength(1);
      expect(body.routes[0]?.package).toBe('demo-pkg');
      expect(body.routes[0]?.routes).toContainEqual({ method: 'GET', path: '/' });
      expect(body.routes[0]?.routes).toContainEqual({
        method: 'GET',
        path: '/api/v1/data/animals',
      });
    });
  });

  it('reports the .cap content hash', async () => {
    const capBytes = await new PackageWriter().packFiles(demoFiles());
    const handler = await createReactor({ package: await writeTempFile(capBytes) });
    await withServer(handler, async (request) => {
      const response = await request('/api/v1/introspect/content-hashes');
      expect(response.status).toBe(200);
      const body = contentHashesResponseSchema.parse(JSON.parse(response.body));
      const expected = createHash('sha256').update(capBytes).digest('hex');
      expect(body).toEqual({ contentHashes: [{ package: 'demo-pkg', hash: expected }] });
    });
  });

  it('reports content validity', async () => {
    const capBytes = await new PackageWriter().packFiles(demoFiles());
    const handler = await createReactor({ package: await writeTempFile(capBytes) });
    await withServer(handler, async (request) => {
      const response = await request('/api/v1/introspect/content-validity');
      expect(response.status).toBe(200);
      const body = contentValidityResponseSchema.parse(JSON.parse(response.body));
      expect(body.contentValidity).toHaveLength(1);
      expect(body.contentValidity[0]?.package).toBe('demo-pkg');
      expect(body.contentValidity[0]?.valid).toBe(true);
    });
  });
});

/* ------------------------------------------------------------------ */
/* Fail-fast init (integrity, encryption)                              */
/* ------------------------------------------------------------------ */

describe('init verification', () => {
  it('rejects a tampered package at init with PackageIntegrityError', async () => {
    const archive = new CapArchive();
    const capBytes = await new PackageWriter().packFiles(demoFiles());
    const unpacked = archive.unpack(capBytes);
    unpacked.set('content/index.html', text('<h1>tampered</h1>'));
    const tamperedPath = await writeTempFile(archive.pack(unpacked));
    await expect(createReactor({ package: tamperedPath })).rejects.toThrow(PackageIntegrityError);
    await expect(createReactor({ package: tamperedPath })).rejects.toThrow(/checksum-mismatch/);
  });

  const recipient = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  async function encryptedCapPath(): Promise<string> {
    const capBytes = await new PackageWriter().packFiles(demoFiles());
    const encrypted = await new PackageCipher().encryptBytes(capBytes, recipient.publicKey);
    return await writeTempFile(encrypted);
  }

  it('rejects an encrypted package without a key', async () => {
    await expect(createReactor({ package: await encryptedCapPath() })).rejects.toThrow(
      EncryptedPackageError,
    );
  });

  it('serves an encrypted package with the decryption key', async () => {
    const handler = await createReactor({
      package: await encryptedCapPath(),
      decryptionKeyPem: recipient.privateKey,
    });
    await withServer(handler, async (request) => {
      const response = await request('/');
      expect(response.status).toBe(200);
      expect(response.body).toBe('<!doctype html><h1>Demo</h1>');
    });
  });
});

/* ------------------------------------------------------------------ */
/* §4a composite packages                                              */
/* ------------------------------------------------------------------ */

const CORE_GUID = 'capsium://example.com/core';

function coreDepFiles(): Map<string, Uint8Array> {
  return new Map([
    [
      'metadata.json',
      json({
        name: 'core',
        version: '1.4.1',
        description: 'Dependency package',
        guid: CORE_GUID,
        uuid: '123e4567-e89b-12d3-a456-4266141740aa',
      }),
    ],
    [
      'manifest.json',
      json({
        resources: {
          'content/app.js': { type: 'text/javascript', visibility: 'exported' },
          'content/hello.txt': { type: 'text/plain', visibility: 'exported' },
          'content/secret.js': { type: 'text/javascript', visibility: 'private' },
        },
      }),
    ],
    ['content/app.js', text('export const from = "core";')],
    ['content/hello.txt', text('hello from core')],
    ['content/secret.js', text('export const secret = 42;')],
  ]);
}

function compositeMainFiles(): Map<string, Uint8Array> {
  return new Map([
    [
      'metadata.json',
      json({
        name: 'site',
        version: '2.0.0',
        description: 'Composite dependent package',
        guid: 'capsium://example.com/site',
        uuid: '123e4567-e89b-12d3-a456-4266141740bb',
        dependencies: { [CORE_GUID]: '>=1.0.0 <2.0.0' },
      }),
    ],
    ['content/index.html', text('<!doctype html><h1>Site</h1>')],
    [
      'routes.json',
      json({
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/vendor/core/app.js', resource: `${CORE_GUID}/content/app.js` },
          { path: '/vendor/core/secret.js', resource: `${CORE_GUID}/content/secret.js` },
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
        ],
      }),
    ],
  ]);
}

async function compositeStore(): Promise<string> {
  const storeDir = await mkdtemp(join(tmpdir(), 'capsium-reactor-store-'));
  const depCap = await new PackageWriter().packFiles(coreDepFiles());
  await writeFile(join(storeDir, 'core-1.4.1.cap'), depCap);
  return storeDir;
}

describe('composite packages (§4a)', () => {
  it('serves dependency resources resolved from the store', async () => {
    const handler = await createReactor({
      package: await writePackageDir(compositeMainFiles()),
      store: await compositeStore(),
    });
    await withServer(handler, async (request) => {
      const response = await request('/vendor/core/app.js');
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/javascript');
      expect(response.body).toBe('export const from = "core";');
    });
  });

  it('rejects references to private dependency resources', async () => {
    const handler = await createReactor({
      package: await writePackageDir(compositeMainFiles()),
      store: await compositeStore(),
    });
    await withServer(handler, async (request) => {
      const response = await request('/vendor/core/secret.js');
      expect(response.status).toBe(404);
      expect(JSON.parse(response.body)).toEqual({
        error: `dependency resource is private: ${CORE_GUID}/content/secret.js`,
      });
    });
  });

  it('applies route inheritance response processing', async () => {
    const handler = await createReactor({
      package: await writePackageDir(compositeMainFiles()),
      store: await compositeStore(),
    });
    await withServer(handler, async (request) => {
      const rewritten = await request('/rewritten');
      expect(rewritten.status).toBe(200);
      expect(rewritten.body).toBe('REWRITTEN');
      expect(rewritten.headers.get('x-rewrite')).toBe('yes');
      expect(rewritten.headers.get('content-length')).toBe(String('REWRITTEN'.length));

      const enhanced = await request('/enhanced');
      expect(enhanced.status).toBe(200);
      expect(enhanced.headers.get('x-enhanced')).toBe('1');
      // responseHeaders merge over the served headers: Content-Type is overridden.
      expect(enhanced.headers.get('content-type')).toBe('text/html');
    });
  });

  it('fails init when a dependency cannot be satisfied (no store)', async () => {
    const saved = process.env['CAPSIUM_STORE'];
    delete process.env['CAPSIUM_STORE'];
    try {
      await expect(
        createReactor({ package: await writePackageDir(compositeMainFiles()) }),
      ).rejects.toThrow(DependencyResolutionError);
    } finally {
      if (saved !== undefined) {
        process.env['CAPSIUM_STORE'] = saved;
      }
    }
  });
});

/* ------------------------------------------------------------------ */
/* §5a layered storage                                                 */
/* ------------------------------------------------------------------ */

function layeredFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json({ ...metadata, name: 'layered-pkg' })],
    [
      'storage.json',
      json({
        storage: {
          dataSets: { animals: { source: 'data/animals.json' } },
          layers: [
            { path: 'base', writable: false, visibility: 'exported' },
            { path: 'updates', writable: true, visibility: 'private' },
          ],
        },
      }),
    ],
    [
      'routes.json',
      json({
        index: 'content/index.html',
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/about', resource: 'content/about.html' },
          { path: '/gone', resource: 'content/gone.html' },
          { path: '/api/v1/data/animals', dataset: 'animals' },
        ],
      }),
    ],
    ['base/index.html', text('<h1>base index</h1>')],
    ['base/about.html', text('<h1>base about</h1>')],
    ['base/gone.html', text('<h1>gone</h1>')],
    ['updates/about.html', text('<h1>updated about</h1>')],
    ['updates/.capsium-tombstones', json(['gone.html'])],
    ['data/animals.json', json([{ name: 'fox' }])],
  ]);
}

describe('layered storage (§5a)', () => {
  it('resolves top-first and 404s tombstoned paths', async () => {
    const handler = await createReactor({ package: await writePackageDir(layeredFiles()) });
    await withServer(handler, async (request) => {
      // The upper layer shadows the base layer.
      const about = await request('/about');
      expect(about.status).toBe(200);
      expect(about.body).toBe('<h1>updated about</h1>');
      // Tombstoned in the top layer: 404 although the base layer has it.
      const gone = await request('/gone');
      expect(gone.status).toBe(404);
      expect(JSON.parse(gone.body)).toEqual({ error: 'resource deleted: content/gone.html' });
      // Only in the base layer.
      const index = await request('/');
      expect(index.status).toBe(200);
      expect(index.body).toBe('<h1>base index</h1>');
      // Dataset sources are package files: they bypass the layers (as in
      // the Ruby reactor, which reads them directly).
      const animals = await request('/api/v1/data/animals');
      expect(JSON.parse(animals.body)).toEqual([{ name: 'fox' }]);
    });
  });
});
