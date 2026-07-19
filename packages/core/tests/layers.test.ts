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

// §5a layout: layers mirror the content/ tree (layer `base` serves
// `base/index.html` as `content/index.html`); the content/ tree itself is
// always the implicit bottom layer.
function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', text('{"name":"x"}')],
    ['content/local.txt', text('implicit content layer')],
    ['base/index.html', text('<h1>base</h1>')],
    ['base/about.html', text('<h1>about base</h1>')],
    ['updates/about.html', text('<h1>about updated</h1>')],
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
  it('the implicit content/ layer is always the bottom layer', () => {
    expect(storageLayers(undefined)).toEqual([{ path: 'content' }]);
    expect(storageLayers({ storage: { dataSets: {} } })).toEqual([{ path: 'content' }]);
    expect(storageLayers(layeredStorage).map((layer) => layer.path)).toEqual([
      'content',
      'base',
      'updates',
    ]);
  });

  it('excludes private layers from the dependent view', () => {
    expect(visibleLayers(layeredStorage, 'self').map((layer) => layer.path)).toEqual([
      'content',
      'base',
      'updates',
    ]);
    expect(visibleLayers(layeredStorage, 'dependent').map((layer) => layer.path)).toEqual([
      'content',
      'base',
    ]);
  });
});

describe('resolveLayeredPath (top → bottom)', () => {
  it('resolves from the only layer that has the file', () => {
    const resolution = resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/index.html');
    expect(resolution).toMatchObject({ kind: 'found', path: 'base/index.html' });
  });

  it('first hit from the top wins', () => {
    const resolution = resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/about.html');
    expect(resolution).toMatchObject({ kind: 'found', path: 'updates/about.html' });
  });

  it('serves from the implicit content/ layer below the configured layers', () => {
    const resolution = resolveLayeredPath(fixtureFiles(), layeredStorage, 'content/local.txt');
    expect(resolution).toMatchObject({ kind: 'found', path: 'content/local.txt' });
  });

  it('resolves against the implicit content/ layer without a layers config', () => {
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
    ).toMatchObject({ kind: 'found', path: 'base/about.html' });
  });

  it('paths outside content/ bypass the layers and address package files directly', () => {
    const files = new Map([['data/animals.json', json([])]]);
    expect(resolveLayeredPath(files, layeredStorage, 'data/animals.json')).toMatchObject({
      kind: 'found',
      path: 'data/animals.json',
    });
    expect(resolveLayeredPath(files, layeredStorage, 'data/missing.json')).toEqual({
      kind: 'not-found',
    });
  });

  it('never serves the tombstone marker itself', () => {
    const files = fixtureFiles();
    files.set(`updates/${TOMBSTONES_FILE}`, json(['index.html']));
    expect(
      resolveLayeredPath(files, layeredStorage, `content/${TOMBSTONES_FILE}`),
    ).toEqual({ kind: 'not-found' });
  });
});

describe('tombstones', () => {
  it('tombstoned paths resolve 404 even when a lower layer has the file', () => {
    const files = fixtureFiles();
    files.set(`updates/${TOMBSTONES_FILE}`, json(['index.html']));
    expect(resolveLayeredPath(files, layeredStorage, 'content/index.html')).toEqual({
      kind: 'tombstoned',
    });
  });

  it('a file present above the tombstone layer still wins (first hit)', () => {
    const files = fixtureFiles();
    // base tombstones about.html, but updates (above) re-adds it.
    files.set(`base/${TOMBSTONES_FILE}`, json(['about.html']));
    expect(resolveLayeredPath(files, layeredStorage, 'content/about.html')).toMatchObject({
      kind: 'found',
      path: 'updates/about.html',
    });
  });

  it('a tombstone without a file in any layer still reports tombstoned', () => {
    const files = fixtureFiles();
    files.set(`updates/${TOMBSTONES_FILE}`, json(['gone.html']));
    expect(resolveLayeredPath(files, layeredStorage, 'content/gone.html')).toEqual({
      kind: 'tombstoned',
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

  it('layerFilePath strips the content/ prefix when joining a layer', () => {
    expect(layerFilePath({ path: 'base' }, 'content/x.html')).toBe('base/x.html');
    expect(layerFilePath({ path: 'content' }, 'content/x.html')).toBe('content/x.html');
  });
});
