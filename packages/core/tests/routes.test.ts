import { describe, expect, it } from 'vitest';
import {
  isDatasetRoute,
  isHandlerRoute,
  isResourceRoute,
  parseRoutes,
  routesSchema,
} from '../src/index.js';

const canonical = {
  index: 'content/index.html',
  routes: [
    { path: '/', resource: 'content/index.html' },
    { path: '/index.html', resource: 'content/index.html' },
    { path: '/about', resource: 'content/about.html' },
    {
      path: '/styles.css',
      resource: 'content/styles.css',
      headers: { 'Cache-Control': 'public, max-age=31536000' },
    },
    { path: '/api/v1/data/animals', dataset: 'animals' },
    { path: '/api/v1/echo', method: 'POST', handler: 'handlers/echo.lua', extra: 'kept' },
  ],
};

describe('routesSchema (§4)', () => {
  it('accepts the canonical array form with all three route kinds', () => {
    const parsed = routesSchema.parse(canonical);
    expect(parsed.index).toBe('content/index.html');
    expect(parsed.routes).toHaveLength(6);
  });

  it('discriminates route kinds by key', () => {
    const { routes } = routesSchema.parse(canonical);
    const [slash, , , , dataset, handler] = routes;
    expect(slash !== undefined && isResourceRoute(slash)).toBe(true);
    expect(dataset !== undefined && isDatasetRoute(dataset)).toBe(true);
    expect(handler !== undefined && isHandlerRoute(handler)).toBe(true);
    if (handler !== undefined && isHandlerRoute(handler)) {
      expect(handler.extra).toBe('kept');
    }
  });

  it('rejects a dataset route outside /api/v1/data/', () => {
    expect(() =>
      routesSchema.parse({ routes: [{ path: '/data/animals', dataset: 'animals' }] }),
    ).toThrow();
  });

  it('rejects a route with both headers and headersFile', () => {
    expect(() =>
      routesSchema.parse({
        routes: [
          {
            path: '/a',
            resource: 'content/a.txt',
            headers: { 'X-Test': '1' },
            headersFile: 'content/headers.json',
          },
        ],
      }),
    ).toThrow();
  });
});

describe('parseRoutes legacy normalization', () => {
  it('normalizes the object-keyed-by-path form (object values)', () => {
    const parsed = parseRoutes({
      index: 'content/index.html',
      routes: {
        '/': { resource: 'content/index.html' },
        '/about': { resource: 'content/about.html', visibility: 'private' },
      },
    });
    expect(parsed).toEqual({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/about', resource: 'content/about.html', visibility: 'private' },
      ],
    });
  });

  it('accepts string shorthand values as resource routes', () => {
    const parsed = parseRoutes({ routes: { '/styles.css': 'content/styles.css' } });
    expect(parsed.routes).toEqual([{ path: '/styles.css', resource: 'content/styles.css' }]);
  });

  it('emits only the array form after normalization', () => {
    const parsed = parseRoutes({ routes: { '/': 'content/index.html' } });
    expect(Array.isArray(parsed.routes)).toBe(true);
  });

  it('rejects input matching neither form', () => {
    expect(() => parseRoutes({ routes: 42 })).toThrow();
  });
});
