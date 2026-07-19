/**
 * JSON Schema deliverable tests: the generated draft 2020-12 documents are
 * structurally sound ($id/dialect/required keys, locally resolvable $refs),
 * the committed schemas/ files match the models (drift guard — regenerate
 * with `yarn workspace @capsium/core build:schemas`), and canonical
 * fixtures round-trip through the same zod models the schemas are
 * generated from (a valid package passes, a broken one fails).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildJsonSchemas,
  parseAuthentication,
  parseManifest,
  parseMetadata,
  parseRoutes,
  parseSecurity,
  parseStorage,
  JSON_SCHEMA_DIALECT,
  JSON_SCHEMA_ID_BASE,
} from '../src/index.js';

const SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');

/** Collect every `$ref` value in a schema document. */
function collectRefs(node: unknown, refs: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectRefs(item, refs);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') {
        refs.push(value);
      } else {
        collectRefs(value, refs);
      }
    }
  }
  return refs;
}

/** Resolve a local JSON pointer (`#/...`) against the document root. */
function resolveLocalPointer(document: unknown, ref: string): unknown {
  let current = document;
  for (const segment of ref.slice(2).split('/')) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  return current;
}

describe('buildJsonSchemas', () => {
  const schemas = buildJsonSchemas();

  it('emits the six canonical config schemas, draft 2020-12 with canonical $ids', () => {
    expect(schemas.map((schema) => schema.name)).toEqual([
      'metadata',
      'manifest',
      'routes',
      'storage',
      'security',
      'authentication',
    ]);
    for (const schema of schemas) {
      expect(schema.fileName).toBe(`${schema.name}.schema.json`);
      expect(schema.id).toBe(`${JSON_SCHEMA_ID_BASE}${schema.name}.schema.json`);
      expect(schema.schema['$id']).toBe(schema.id);
      expect(schema.schema['$schema']).toBe(JSON_SCHEMA_DIALECT);
      expect(schema.schema['type']).toBe('object');
    }
  });

  it('requires the §2 metadata fields and describes all canonical keys', () => {
    const metadata = schemas.find((schema) => schema.name === 'metadata')?.schema;
    expect(metadata?.['required']).toEqual(['name', 'version', 'description', 'guid', 'uuid']);
    expect(Object.keys(metadata?.['properties'] as Record<string, unknown>)).toEqual(
      expect.arrayContaining([
        'name',
        'version',
        'description',
        'guid',
        'uuid',
        'author',
        'license',
        'repository',
        'dependencies',
        'readOnly',
      ]),
    );
  });

  it('requires the top-level key of each generated config file', () => {
    const requiredBy = (name: string): unknown =>
      schemas.find((schema) => schema.name === name)?.schema['required'];
    expect(requiredBy('manifest')).toEqual(['resources']);
    expect(requiredBy('routes')).toEqual(['routes']);
    expect(requiredBy('storage')).toEqual(['storage']);
    expect(requiredBy('security')).toEqual(['security']);
    expect(requiredBy('authentication')).toEqual(['authentication']);
  });

  it('describes route kinds as a union (anyOf) under routes.items', () => {
    const routes = schemas.find((schema) => schema.name === 'routes')?.schema;
    const items = (routes?.['properties'] as Record<string, Record<string, unknown>>)['routes'];
    expect(items?.['items']).toHaveProperty('anyOf');
  });

  it('keeps every $ref resolvable within its own document', () => {
    for (const schema of schemas) {
      for (const ref of collectRefs(schema.schema)) {
        expect(ref.startsWith('#/')).toBe(true);
        expect(resolveLocalPointer(schema.schema, ref)).toBeDefined();
      }
    }
  });

  it('matches the committed schemas/ documents (drift guard)', () => {
    const files = readdirSync(SCHEMAS_DIR).filter((file) => file.endsWith('.schema.json'));
    expect(files.sort()).toEqual(schemas.map((schema) => schema.fileName).sort());
    for (const schema of schemas) {
      const committed: unknown = JSON.parse(readFileSync(join(SCHEMAS_DIR, schema.fileName), 'utf8'));
      expect(committed).toEqual(schema.schema);
    }
  });
});

/* ------------------------------------------------------------------ */
/* Fixture round-trips through the models the schemas are built from.  */
/* ------------------------------------------------------------------ */

const validMetadata = {
  name: 'story-of-claire',
  version: '1.0.0',
  description: 'A valid package',
  guid: 'https://github.com/capsiums/cap-story',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  author: 'Ribose',
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/capsiums/cap-story' },
  dependencies: { 'capsium://example.com/other-pkg': '>=1.0.0' },
  readOnly: true,
};

const validManifest = {
  resources: {
    'content/index.html': { type: 'text/html', visibility: 'exported' },
    'content/styles.css': { type: 'text/css', visibility: 'private', version: '1.0.0' },
  },
};

const validRoutes = {
  index: 'content/index.html',
  routes: [
    { path: '/', resource: 'content/index.html' },
    {
      path: '/styles.css',
      resource: 'content/styles.css',
      headers: { 'Cache-Control': 'public, max-age=31536000' },
    },
    { path: '/api/v1/data/animals', dataset: 'animals' },
    { path: '/api/echo', method: 'POST', handler: 'content/echo.js' },
  ],
};

const validStorage = {
  storage: {
    dataSets: {
      animals: {
        source: 'data/animals.json',
        schemaFile: 'data/animals.schema.json',
        schemaType: 'json-schema',
      },
      sales: { databaseFile: 'data/sales.db', table: 'sales' },
    },
    layers: [
      { path: 'base', writable: false, visibility: 'exported' },
      { path: 'updates', writable: true, visibility: 'private' },
    ],
  },
};

const validSecurity = {
  security: {
    integrityChecks: {
      checksumAlgorithm: 'SHA-256',
      checksums: { 'content/index.html': 'a'.repeat(64) },
    },
    digitalSignatures: { publicKey: 'keys/public.pem', signatureFile: 'signature.sig' },
  },
};

const validAuthentication = {
  authentication: {
    basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd', realm: 'capsium' },
    oauth2: {
      enabled: true,
      provider: 'google',
      clientId: 'id',
      authorizationUrl: 'https://example.com/auth',
      tokenUrl: 'https://example.com/token',
      userinfoUrl: 'https://example.com/userinfo',
      redirectPath: '/auth/callback',
      scopes: ['openid', 'email'],
    },
  },
};

describe('canonical fixtures against the schema source models', () => {
  it('accepts valid config documents', () => {
    expect(parseMetadata(validMetadata).name).toBe('story-of-claire');
    expect(parseManifest(validManifest).resources['content/index.html']?.type).toBe('text/html');
    expect(parseRoutes(validRoutes).routes).toHaveLength(4);
    expect(parseStorage(validStorage).storage.dataSets['animals']).toBeDefined();
    expect(parseSecurity(validSecurity).security.integrityChecks.checksumAlgorithm).toBe('SHA-256');
    expect(parseAuthentication(validAuthentication).authentication.basicAuth?.enabled).toBe(true);
  });

  it('rejects broken config documents', () => {
    const { name: _name, ...metadataWithoutName } = validMetadata;
    expect(() => parseMetadata(metadataWithoutName)).toThrow();
    expect(() => parseMetadata({ ...validMetadata, uuid: 'not-a-uuid' })).toThrow();
    expect(() => parseManifest({ resources: { 'content/x': {} } })).toThrow();
    expect(() => parseRoutes({ routes: [{ path: '/data/x', dataset: 'x' }] })).toThrow();
    expect(() => parseStorage({ storage: { dataSets: { animals: {} } } })).toThrow();
    expect(() =>
      parseSecurity({ security: { integrityChecks: { checksumAlgorithm: 'MD5', checksums: {} } } }),
    ).toThrow();
    expect(() => parseAuthentication({ authentication: { basicAuth: { enabled: 'yes' } } })).toThrow();
  });
});
