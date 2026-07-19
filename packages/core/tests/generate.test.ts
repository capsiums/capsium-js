import { describe, expect, it } from 'vitest';
import { buildManifest, buildRoutes } from '../src/index.js';

/**
 * Golden tests for §3/§4 auto-generation: a fixed file tree must produce
 * exactly this manifest.json and routes.json.
 */

const fileTree = new Map<string, string>([
  ['metadata.json', 'application/json'],
  ['content/index.html', 'text/html'],
  ['content/about.html', 'text/html'],
  ['content/docs/guide.html', 'text/html'],
  ['content/styles.css', 'text/css'],
  ['content/images/logo.png', 'image/png'],
  ['data/animals.json', 'application/json'],
]);

const storage = {
  storage: {
    dataSets: {
      animals: {
        source: 'data/animals.json',
        schemaFile: 'data/animals.schema.json',
        schemaType: 'json-schema',
      },
      sales: { databaseFile: 'data/sales.db', table: 'sales' },
    },
  },
} as const;

describe('buildManifest (§3)', () => {
  it('inventories content/ only, exported by default, sorted keys', () => {
    expect(buildManifest(fileTree)).toEqual({
      resources: {
        'content/about.html': { type: 'text/html', visibility: 'exported' },
        'content/docs/guide.html': { type: 'text/html', visibility: 'exported' },
        'content/images/logo.png': { type: 'image/png', visibility: 'exported' },
        'content/index.html': { type: 'text/html', visibility: 'exported' },
        'content/styles.css': { type: 'text/css', visibility: 'exported' },
      },
    });
  });
});

describe('buildRoutes (§4)', () => {
  it('produces the exact canonical routes for the fixture tree', () => {
    const manifest = buildManifest(fileTree);
    expect(buildRoutes(manifest, storage)).toEqual({
      index: 'content/index.html',
      routes: [
        // The index HTML additionally gets '/', emitted first.
        { path: '/', resource: 'content/index.html' },
        // Every HTML file gets TWO routes: extensionless + full filename.
        { path: '/about', resource: 'content/about.html' },
        { path: '/about.html', resource: 'content/about.html' },
        { path: '/docs/guide', resource: 'content/docs/guide.html' },
        { path: '/docs/guide.html', resource: 'content/docs/guide.html' },
        // Non-HTML resources get a single route relative to content/.
        { path: '/images/logo.png', resource: 'content/images/logo.png' },
        { path: '/index', resource: 'content/index.html' },
        { path: '/index.html', resource: 'content/index.html' },
        { path: '/styles.css', resource: 'content/styles.css' },
        // Every dataset gets /api/v1/data/<id>, sorted by id.
        { path: '/api/v1/data/animals', dataset: 'animals' },
        { path: '/api/v1/data/sales', dataset: 'sales' },
      ],
    });
  });

  it('omits index when content/index.html is absent', () => {
    const manifest = buildManifest(new Map([['content/a.txt', 'text/plain']]));
    expect(buildRoutes(manifest)).toEqual({
      routes: [{ path: '/a.txt', resource: 'content/a.txt' }],
    });
  });

  it('works without storage (no dataset routes)', () => {
    const manifest = buildManifest(new Map([['content/index.html', 'text/html']]));
    expect(buildRoutes(manifest)).toEqual({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/index', resource: 'content/index.html' },
        { path: '/index.html', resource: 'content/index.html' },
      ],
    });
  });
});
