import { describe, expect, it } from 'vitest';
import {
  layerFilePath,
  layerTombstones,
  layerVisibility,
  layerWritable,
  parseStorage,
  resolveLayeredPath,
  storageLayers,
  visibleLayers,
  TOMBSTONES_FILE,
  type Storage,
} from '../src/index.js';
import { text, json } from './helpers.js';

const layeredStorage: Storage = {
  storage: {
    dataSets: {},
    layers: [
      { path: 'base', writable: false, visibility: 'exported' },
      { path: 'updates', writable: true, visibility: 'private' },
    ],
  },
};

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', text('{"name":"x"}')],
    ['base/content/index.html', text('<h1>base</h1>')],
    ['base/content/about.html', text('<h1>about base</h1>')],
    ['updates/content/about.html', text('<h1>about updated</h1>')],
  ]);
}

describe('storage.json layers model (§5a)', () => {
  it('parses layers with defaults applied by accessors', () => {
    const storage = parseStorage({
      storage: {
        layers: [
          { path: 'base', writable: false, visibility: 'exported' },
          { path: 'updates', writable: true, visibility: 'private' },
        ],
      },
    });
    expect(storage.storage.layers).toHaveLength(2);
    expect(storage.storage.dataSets).toEqual({});
    const [base, updates] = storage.storage.layers ?? [];
    expect(layerWritable(base!)).toBe(false);
    expect(layerVisibility(base!)).toBe('exported');
    expect(layerWritable(updates!)).toBe(true);
    expect(layerVisibility(updates!)).toBe('private');
  });

  it('defaults writable/visibility when omitted', () => {
    const storage = parseStorage({ storage: { layers: [{ path: 'base' }] } });
    const [base] = storage.storage.layers ?? [];
    expect(layerWritable(base!)).toBe(false);
    expect(layerVisibility(base!)).toBe('exported');
  });

  it('still parses dataset-only storage without layers', () => {
    const storage = parseStorage({
      storage: { dataSets: { animals: { source: 'data/animals.json' } } },
    });
    expect(storage.storage.layers).toBeUndefined();
    expect(Object.keys(storage.storage.dataSets)).toEqual(['animals']);
  });
});

describe('storageLayers / visibleLayers', () => {
  it('behaves as a single implicit root layer without a layers config', () => {
    expect(storageLayers(undefined)).toEqual([{ path: '' }]);
    expect(storageLayers({ storage: { dataSets: {} } })).toEqual([{ path: '' }]);
  });

  it('keeps declaration order (bottom → top)', () => {
    expect(storageLayers(layeredStorage).map((layer) => layer.path)).toEqual(['base', 'updates']);
  });

  it('excludes private layers from the dependent view', () => {
    expect(visibleLayers(layeredStorage, 'self').map((layer) => layer.path)).toEqual([
      'base',
      'updates',
    ]);
    expect(visibleLayers(layeredStorage, 'dependent').map((layer) => layer.path)).toEqual([
      'base',
    ]);
  });
});

describe('resolveLayeredPath (top → bottom)', () => {
  it('resolves from the only layer that has the file', () => {
    const resolution = resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/index.html');
    expect(resolution).toMatchObject({ kind: 'found', path: 'base/content/index.html' });
  });

  it('first hit from the top wins', () => {
    const resolution = resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/about.html');
    expect(resolution).toMatchObject({ kind: 'found', path: 'updates/content/about.html' });
  });

  it('resolves against the implicit root layer without a layers config', () => {
    const files = new Map([['content/index.html', text('<h1>root</h1>')]]);
    expect(resolveLayeredPath(files, undefined, 'content/index.html')).toMatchObject({
      kind: 'found',
      path: 'content/index.html',
    });
  });

  it('reports not-found for unknown paths', () => {
    expect(resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/nope.html')).toEqual({
      kind: 'not-found',
    });
  });

  it('does not see private-layer files from the dependent view', () => {
    expect(
      resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/about.html', 'dependent'),
    ).toMatchObject({ kind: 'found', path: 'base/content/about.html' });
  });
});

describe('tombstones', () => {
  it('tombstoned paths resolve 404 even when a lower layer has the file', () => {
    const files = fixtureFiles();
    files.set(`updates/${TOMBSTONES_FILE}`, json(['content/index.html']));
    expect(resolveLayeredPath(files, layeredStorage, 'content/index.html')).toEqual({
      kind: 'tombstoned',
    });
  });

  it('a file present above the tombstone layer still wins (first hit)', () => {
    const files = fixtureFiles();
    // base tombstones about.html, but updates (above) re-adds it.
    files.set(`base/${TOMBSTONES_FILE}`, json(['content/about.html']));
    expect(resolveLayeredPath(files, layeredStorage, 'content/about.html')).toMatchObject({
      kind: 'found',
      path: 'updates/content/about.html',
    });
  });

  it('reads tombstones only from the layer file, tolerating malformed JSON', () => {
    const files = fixtureFiles();
    files.set(`updates/${TOMBSTONES_FILE}`, text('not json'));
    expect(layerTombstones(files, { path: 'updates' })).toEqual(new Set());
    expect(resolveLayeredPath(files, layeredStorage, 'content/index.html')).toMatchObject({
      kind: 'found',
    });
  });

  it('layerFilePath joins layer dir and merged path (root layer passes through)', () => {
    expect(layerFilePath({ path: 'base' }, 'content/x.html')).toBe('base/content/x.html');
    expect(layerFilePath({ path: '' }, 'content/x.html')).toBe('content/x.html');
  });
});
