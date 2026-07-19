import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DependencyResolutionError } from '@capsium/core';
import { PackageWriter, StoreDirectory } from '../src/index.js';

const CORE_GUID = 'capsium://example.com/core';
const EXTRA_GUID = 'capsium://example.com/extra';

const writer = new PackageWriter();

let storeDir: string;

function packageFiles(name: string, version: string, guid: string): Map<string, Uint8Array> {
  const metadata = {
    name,
    version,
    description: `${name} fixture`,
    guid,
    uuid: '123e4567-e89b-12d3-a456-426614174000',
  };
  return new Map([
    ['metadata.json', new TextEncoder().encode(JSON.stringify(metadata))],
    ['content/index.html', new TextEncoder().encode(`<h1>${name} ${version}</h1>`)],
  ]);
}

beforeAll(async () => {
  storeDir = await mkdtemp(join(tmpdir(), 'capsium-store-'));
  const fixtures: Array<[string, string, string]> = [
    ['core', '1.0.0', CORE_GUID],
    ['core', '1.4.1', CORE_GUID],
    ['core', '2.0.0', CORE_GUID],
    ['extra', '0.3.0', EXTRA_GUID],
  ];
  for (const [name, version, guid] of fixtures) {
    const dir = await mkdtemp(join(tmpdir(), `capsium-store-src-${name}-`));
    const files = packageFiles(name, version, guid);
    for (const [path, bytes] of files) {
      const full = join(dir, ...path.split('/'));
      await mkdir(join(full, '..'), { recursive: true });
      await writeFile(full, bytes);
    }
    await writer.writeCap(dir, join(storeDir, `${name}-${version}.cap`));
    await rm(dir, { recursive: true, force: true });
  }
  // index.json: explicit guid -> file mapping for one package.
  await writeFile(
    join(storeDir, 'index.json'),
    JSON.stringify({ [EXTRA_GUID]: 'extra-0.3.0.cap' }),
  );
});

afterAll(async () => {
  await rm(storeDir, { recursive: true, force: true });
});

describe('StoreDirectory (§4a package store)', () => {
  it('lists every .cap with identity from its metadata.json', async () => {
    const entries = await new StoreDirectory(storeDir).list();
    const byVersion = entries
      .filter((entry) => entry.guid === CORE_GUID)
      .map((entry) => entry.version)
      .sort();
    expect(byVersion).toEqual(['1.0.0', '1.4.1', '2.0.0']);
    expect(entries.find((entry) => entry.guid === EXTRA_GUID)?.file).toBe(
      join(storeDir, 'extra-0.3.0.cap'),
    );
  });

  it('resolves dependencies to the newest satisfying version', async () => {
    const resolved = await new StoreDirectory(storeDir).resolve({
      [CORE_GUID]: '>=1.0.0 <2.0.0',
      [EXTRA_GUID]: '^0.3.0',
    });
    expect(resolved.get(CORE_GUID)?.version).toBe('1.4.1');
    expect(resolved.get(EXTRA_GUID)?.version).toBe('0.3.0');
  });

  it('throws DependencyResolutionError for unsatisfiable dependencies', async () => {
    await expect(
      new StoreDirectory(storeDir).resolve({ [CORE_GUID]: '>=3.0.0' }),
    ).rejects.toThrow(DependencyResolutionError);
  });

  it('loads resolved dependencies as validated models', async () => {
    const loaded = await new StoreDirectory(storeDir).loadDependencies({
      [CORE_GUID]: '>=1.5.0',
      [EXTRA_GUID]: '>=0.1.0',
    });
    expect(loaded.get(CORE_GUID)?.metadata.version).toBe('2.0.0');
    expect(loaded.get(EXTRA_GUID)?.metadata.name).toBe('extra');
  });
});
