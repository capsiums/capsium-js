import { describe, expect, it } from 'vitest';
import {
  MissingPackageFileError,
  PackageConfigError,
  parsePackage,
} from '../src/index.js';
import { json, text, validMetadata } from './helpers.js';

describe('parsePackage', () => {
  it('auto-generates manifest and routes when absent (§1)', () => {
    const pkg = parsePackage(
      new Map([
        ['metadata.json', json(validMetadata)],
        ['content/index.html', text('<h1>Hello</h1>')],
        ['content/app.js', text('console.log(1)')],
      ]),
    );
    expect(pkg.metadata.name).toBe('story-of-claire');
    expect(pkg.manifest).toEqual({
      resources: {
        'content/app.js': { type: 'text/javascript', visibility: 'exported' },
        'content/index.html': { type: 'text/html', visibility: 'exported' },
      },
    });
    expect(pkg.routes).toEqual({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/app.js', resource: 'content/app.js' },
        { path: '/index', resource: 'content/index.html' },
        { path: '/index.html', resource: 'content/index.html' },
      ],
    });
    expect(pkg.storage).toBeUndefined();
    expect(pkg.security).toBeUndefined();
  });

  it('preserves hand-authored manifest/routes and parses storage/security', () => {
    const manifest = { resources: { 'content/index.html': { type: 'text/html' } } };
    const routes = { routes: [{ path: '/home', resource: 'content/index.html' }] };
    const storage = {
      storage: { dataSets: { animals: { source: 'data/animals.json' } } },
    };
    const pkg = parsePackage(
      new Map([
        ['metadata.json', json(validMetadata)],
        ['manifest.json', json(manifest)],
        ['routes.json', json(routes)],
        ['storage.json', json(storage)],
        ['content/index.html', text('<h1>Hello</h1>')],
        ['data/animals.json', json([{ name: 'fox' }])],
      ]),
    );
    expect(pkg.manifest).toEqual(manifest);
    expect(pkg.routes).toEqual(routes);
    expect(pkg.storage).toEqual(storage);
  });

  it('normalizes legacy config forms on read', () => {
    const pkg = parsePackage(
      new Map([
        [
          'metadata.json',
          json({
            ...validMetadata,
            dependencies: [{ name: 'capsium://example.com/dep', version: '^1.0.0' }],
          }),
        ],
        ['manifest.json', json({ content: [{ file: 'content/index.html', mime: 'text/html' }] })],
        ['routes.json', json({ routes: { '/': 'content/index.html' } })],
        ['storage.json', json({ datasets: [{ name: 'animals', source: 'data/animals.json' }] })],
        ['content/index.html', text('<h1>Hello</h1>')],
      ]),
    );
    expect(pkg.metadata.dependencies).toEqual({ 'capsium://example.com/dep': '^1.0.0' });
    expect(pkg.manifest.resources['content/index.html']).toEqual({ type: 'text/html' });
    expect(pkg.routes.routes).toEqual([{ path: '/', resource: 'content/index.html' }]);
    expect(pkg.storage?.storage.dataSets['animals']).toEqual({ source: 'data/animals.json' });
  });

  it('throws MissingPackageFileError without metadata.json', () => {
    expect(() => parsePackage(new Map([['content/index.html', text('x')]]))).toThrow(
      MissingPackageFileError,
    );
  });

  it('throws PackageConfigError for invalid JSON', () => {
    expect(() =>
      parsePackage(new Map([['metadata.json', text('{not json')]])),
    ).toThrow(PackageConfigError);
  });

  it('throws PackageConfigError for schema violations, naming the file', () => {
    expect(() =>
      parsePackage(new Map([['metadata.json', json({ ...validMetadata, version: 'nope' })]])),
    ).toThrow(/metadata\.json/);
  });

  it('uses an injected MIME detector when generating the manifest', () => {
    const pkg = parsePackage(
      new Map([
        ['metadata.json', json(validMetadata)],
        ['content/weird.xyz', text('?')],
      ]),
      { mimeTypeFor: () => 'application/x-weird' },
    );
    expect(pkg.manifest.resources['content/weird.xyz']).toEqual({
      type: 'application/x-weird',
      visibility: 'exported',
    });
  });
});
