import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CapArchive,
  IntegrityVerifier,
  PackageExtractor,
  PackageReader,
  PackageWriter,
} from '../src/index.js';

const metadata = {
  name: 'roundtrip-demo',
  version: '1.0.0',
  description: 'Round-trip fixture package',
  guid: 'https://example.com/roundtrip-demo',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  author: 'Capsium',
  license: 'MIT',
};

const storage = {
  storage: {
    dataSets: {
      animals: {
        source: 'data/animals.json',
        schemaFile: 'data/animals.schema.json',
        schemaType: 'json-schema',
      },
    },
  },
};

const fixtureFiles: Record<string, string> = {
  'metadata.json': JSON.stringify(metadata),
  'storage.json': JSON.stringify(storage),
  'content/index.html': '<!doctype html><h1>Round trip</h1>',
  'content/about.html': '<!doctype html><h1>About</h1>',
  'content/styles.css': 'body { color: black; }',
  'data/animals.json': JSON.stringify([{ name: 'fox' }]),
  'data/animals.schema.json': JSON.stringify({ type: 'array' }),
};

let dir: string;
let capPath: string;
let capBytes: Uint8Array;

const writer = new PackageWriter();
const reader = new PackageReader();
const verifier = new IntegrityVerifier();
const extractor = new PackageExtractor();
const archive = new CapArchive();

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'capsium-packager-'));
  for (const [path, content] of Object.entries(fixtureFiles)) {
    const full = join(dir, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, content);
  }
  capBytes = await writer.packDirectory(dir);
  capPath = join(dir, 'package.cap');
  await writer.writeCap(dir, capPath);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('PackageWriter + PackageReader round-trip', () => {
  it('packs a directory and reads it back with equal models', async () => {
    const model = await reader.readCap(capPath);
    expect(model.metadata).toEqual(metadata);
    expect(model.storage).toEqual(storage);
    expect(model.manifest).toEqual({
      resources: {
        'content/about.html': { type: 'text/html', visibility: 'exported' },
        'content/index.html': { type: 'text/html', visibility: 'exported' },
        'content/styles.css': { type: 'text/css', visibility: 'exported' },
      },
    });
    expect(model.routes).toEqual({
      index: 'content/index.html',
      routes: [
        { path: '/', resource: 'content/index.html' },
        { path: '/about', resource: 'content/about.html' },
        { path: '/about.html', resource: 'content/about.html' },
        { path: '/index', resource: 'content/index.html' },
        { path: '/index.html', resource: 'content/index.html' },
        { path: '/styles.css', resource: 'content/styles.css' },
        { path: '/api/v1/data/animals', dataset: 'animals' },
      ],
    });
  });

  it('materializes manifest.json, routes.json and security.json into the .cap', async () => {
    const fromDisk = new Uint8Array(await readFile(capPath));
    expect(fromDisk).toEqual(capBytes);
    const files = archive.unpack(capBytes);
    expect(files.has('manifest.json')).toBe(true);
    expect(files.has('routes.json')).toBe(true);
    expect(files.has('security.json')).toBe(true);
  });

  it('writeCap output matches packDirectory output (deterministic)', async () => {
    const model = await reader.readCap(capPath);
    expect(model.security).toBeDefined();
  });
});

describe('IntegrityVerifier', () => {
  it('verifies a freshly packed .cap', async () => {
    const report = await verifier.verifyCap(capPath);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('fails verification for a tampered file with the correct issue', async () => {
    const files = archive.unpack(capBytes);
    files.set('content/index.html', new TextEncoder().encode('<h1>tampered</h1>'));
    const tampered = archive.pack(files);
    const report = await verifier.verifyBytes(tampered);
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({
        kind: 'checksum-mismatch',
        path: 'content/index.html',
      }),
    ]);
  });

  it('reports missing-security-file for a package without security.json', async () => {
    const files = archive.unpack(capBytes);
    files.delete('security.json');
    const report = await verifier.verifyBytes(archive.pack(files));
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([{ kind: 'missing-security-file' }]);
  });
});

describe('PackageExtractor', () => {
  it('extracts a .cap back into an equivalent directory', async () => {
    const outDir = await mkdtemp(join(tmpdir(), 'capsium-extract-'));
    try {
      await extractor.extract(capPath, outDir);
      const model = await reader.readDirectory(outDir);
      expect(model.metadata).toEqual(metadata);
      expect((await verifier.verifyDirectory(outDir)).valid).toBe(true);
      const indexHtml = await readFile(join(outDir, 'content', 'index.html'), 'utf8');
      expect(indexHtml).toBe(fixtureFiles['content/index.html']);
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  });
});

describe('PackageWriter.writeSecurityFile', () => {
  it('writes a security.json that verifies', async () => {
    const plainDir = await mkdtemp(join(tmpdir(), 'capsium-security-'));
    try {
      for (const [path, content] of Object.entries(fixtureFiles)) {
        const full = join(plainDir, ...path.split('/'));
        await mkdir(join(full, '..'), { recursive: true });
        await writeFile(full, content);
      }
      await writer.writeSecurityFile(plainDir);
      const securityJson = JSON.parse(await readFile(join(plainDir, 'security.json'), 'utf8'));
      expect(securityJson.security.integrityChecks.checksumAlgorithm).toBe('SHA-256');
      expect((await verifier.verifyDirectory(plainDir)).valid).toBe(true);
    } finally {
      await rm(plainDir, { recursive: true, force: true });
    }
  });
});
