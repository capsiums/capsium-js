import { describe, expect, it } from 'vitest';
import {
  compareSemver,
  isDependencyResourceRef,
  newestSatisfying,
  parseDependencyResourceRef,
  parseSemver,
  planDependencies,
  resolveDependencyResource,
  satisfiesRange,
  DependencyResolutionError,
  type CapsiumPackage,
} from '../src/index.js';
import { json, text, validMetadata } from './helpers.js';

describe('semver helpers', () => {
  it('parses and compares versions', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('v1.2.3-rc.1')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.2')).toBeNull();
    expect(compareSemver('1.2.3', '1.2.10')).toBe(-1);
    expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
    expect(compareSemver('1.10.0', '1.9.9')).toBe(1);
  });

  it.each([
    ['1.2.3', '1.2.3', true],
    ['1.2.4', '1.2.3', false],
    ['1.2.3', '>=1.0.0', true],
    ['0.9.9', '>=1.0.0', false],
    ['2.0.0', '>=1.0.0 <2.0.0', false],
    ['1.5.0', '>=1.0.0 <2.0.0', true],
    ['1.2.9', '^1.2.3', true],
    ['2.0.0', '^1.2.3', false],
    ['0.2.9', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['0.0.3', '^0.0.3', true],
    ['0.0.4', '^0.0.3', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.2.10', '1.2.x', true],
    ['1.3.0', '1.2.x', false],
    ['1.9.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['2.0.0', '<=2.0.0', true],
    ['2.0.1', '<=2.0.0', false],
  ])('satisfiesRange(%s, %s) === %s', (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it('picks the newest satisfying version', () => {
    expect(newestSatisfying(['1.0.0', '1.2.0', '2.0.0', '1.1.0'], '>=1.0.0 <2.0.0')).toBe(
      '1.2.0',
    );
    expect(newestSatisfying(['0.1.0'], '>=1.0.0')).toBeNull();
  });
});

describe('planDependencies (§4a)', () => {
  const candidates = [
    { guid: 'capsium://example.com/core', name: 'core', version: '1.2.0' },
    { guid: 'capsium://example.com/core', name: 'core', version: '1.4.1' },
    { guid: 'capsium://example.com/core', name: 'core', version: '2.0.0' },
    { guid: 'capsium://example.com/extra', name: 'extra', version: '0.3.0' },
  ];

  it('resolves each dependency to the newest satisfying candidate', () => {
    const plan = planDependencies(
      {
        'capsium://example.com/core': '>=1.0.0 <2.0.0',
        'capsium://example.com/extra': '^0.3.0',
      },
      candidates,
    );
    expect(plan.get('capsium://example.com/core')?.version).toBe('1.4.1');
    expect(plan.get('capsium://example.com/extra')?.version).toBe('0.3.0');
  });

  it('throws DependencyResolutionError listing unsatisfiable dependencies', () => {
    expect(() =>
      planDependencies(
        {
          'capsium://example.com/core': '>=3.0.0',
          'capsium://example.com/missing': '1.x',
        },
        candidates,
      ),
    ).toThrow(DependencyResolutionError);
  });
});

describe('dependency resource references (§4a)', () => {
  const guids = ['capsium://example.com/core', 'capsium://example.com/core-plugins'];

  it('parses capsium:// references against known guids (longest wins)', () => {
    expect(isDependencyResourceRef('capsium://example.com/core/content/app.js')).toBe(true);
    expect(isDependencyResourceRef('content/local.js')).toBe(false);
    expect(parseDependencyResourceRef('capsium://example.com/core/content/app.js', guids)).toEqual({
      guid: 'capsium://example.com/core',
      path: 'content/app.js',
    });
    expect(
      parseDependencyResourceRef('capsium://example.com/core-plugins/content/p.js', guids),
    ).toEqual({ guid: 'capsium://example.com/core-plugins', path: 'content/p.js' });
  });

  it('returns null for unknown guids or non-references', () => {
    expect(parseDependencyResourceRef('capsium://other.com/x/content/a.js', guids)).toBeNull();
    expect(parseDependencyResourceRef('content/a.js', guids)).toBeNull();
    expect(parseDependencyResourceRef('capsium://example.com/core', guids)).toBeNull();
  });
});

describe('resolveDependencyResource (exported visibility)', () => {
  const dependency: CapsiumPackage = {
    metadata: { ...validMetadata, guid: 'capsium://example.com/core' },
    manifest: {
      resources: {
        'content/app.js': { type: 'text/javascript', visibility: 'exported' },
        'content/secret.js': { type: 'text/javascript', visibility: 'private' },
      },
    },
    routes: { routes: [] },
    files: new Map([
      ['metadata.json', json(validMetadata)],
      ['content/app.js', text('export default 1;')],
      ['content/secret.js', text('export default 2;')],
    ]),
  };

  it('resolves exported resources', () => {
    expect(resolveDependencyResource(dependency, 'content/app.js')).toEqual({
      kind: 'found',
      path: 'content/app.js',
      type: 'text/javascript',
    });
  });

  it('rejects private resources', () => {
    expect(resolveDependencyResource(dependency, 'content/secret.js')).toEqual({
      kind: 'private',
      path: 'content/secret.js',
    });
  });

  it('reports missing resources as not-found', () => {
    expect(resolveDependencyResource(dependency, 'content/nope.js')).toEqual({
      kind: 'not-found',
      path: 'content/nope.js',
    });
  });

  it('excludes private layers from the dependent view', () => {
    const layered: CapsiumPackage = {
      ...dependency,
      storage: {
        storage: {
          dataSets: {},
          layers: [
            { path: 'base', visibility: 'exported' },
            { path: 'updates', visibility: 'private' },
          ],
        },
      },
      files: new Map([
        ['metadata.json', json(validMetadata)],
        ['base/app.js', text('base')],
        ['updates/app.js', text('private-update')],
      ]),
    };
    expect(resolveDependencyResource(layered, 'content/app.js')).toEqual({
      kind: 'found',
      path: 'base/app.js',
      type: 'text/javascript',
    });
  });
});
