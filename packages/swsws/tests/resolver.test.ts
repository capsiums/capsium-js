import { describe, expect, it } from 'vitest';
import { buildManifest, buildRoutes } from '@capsium/core';
import { matchIntrospection, RouteResolver } from '../src/resolver.js';

const manifest = buildManifest(
  new Map([
    ['content/index.html', 'text/html'],
    ['content/about.html', 'text/html'],
    ['content/styles.css', 'text/css'],
  ]),
);

const routes = buildRoutes(manifest, {
  storage: { dataSets: { animals: { source: 'data/animals.json' } } },
});

const withHandler = {
  ...routes,
  routes: [
    ...routes.routes,
    { path: '/api/v1/echo', method: 'POST', handler: 'handlers/echo.lua' },
  ],
};

describe('RouteResolver', () => {
  const resolver = new RouteResolver(withHandler);

  it.each([
    ['/', 'content/index.html'],
    ['/index', 'content/index.html'],
    ['/index.html', 'content/index.html'],
    ['/about', 'content/about.html'],
    ['/about.html', 'content/about.html'],
    ['/styles.css', 'content/styles.css'],
  ])('resolves %s to resource %s', (path, resource) => {
    expect(resolver.resolve(path)).toEqual({
      kind: 'resource',
      route: { path, resource },
    });
  });

  it('resolves dataset routes', () => {
    expect(resolver.resolve('/api/v1/data/animals')).toEqual({
      kind: 'dataset',
      route: { path: '/api/v1/data/animals', dataset: 'animals' },
    });
  });

  it('flags handler routes on method match (non-JS handlers get a 501)', () => {
    expect(resolver.resolve('/api/v1/echo', 'POST')).toEqual({
      kind: 'handler',
      route: { path: '/api/v1/echo', method: 'POST', handler: 'handlers/echo.lua' },
    });
  });

  it('reports method-not-allowed when only other methods are declared', () => {
    expect(resolver.resolve('/api/v1/echo', 'GET')).toEqual({
      kind: 'method-not-allowed',
      allowed: ['POST'],
    });
  });

  it('reports unknown paths as not-found', () => {
    expect(resolver.resolve('/nope')).toEqual({ kind: 'not-found' });
    expect(resolver.resolve('/about/extra')).toEqual({ kind: 'not-found' });
  });
});

describe('matchIntrospection (§7)', () => {
  it.each([
    ['/api/v1/introspect/metadata', 'metadata'],
    ['/api/v1/introspect/routes', 'routes'],
    ['/api/v1/introspect/content-hashes', 'contentHashes'],
    ['/api/v1/introspect/content-validity', 'contentValidity'],
  ])('matches %s', (path, endpoint) => {
    expect(matchIntrospection(path)).toBe(endpoint);
  });

  it('ignores non-introspection paths', () => {
    expect(matchIntrospection('/api/v1/data/animals')).toBeNull();
    expect(matchIntrospection('/')).toBeNull();
  });
});
