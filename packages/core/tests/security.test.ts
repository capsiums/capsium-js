import { describe, expect, it } from 'vitest';
import {
  buildSecurity,
  computeChecksums,
  parseSecurity,
  securitySchema,
  verifyIntegrity,
} from '../src/index.js';
import { TestHashProvider, text } from './helpers.js';

const hashProvider = new TestHashProvider();

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', text('{"name":"x"}')],
    ['content/index.html', text('<h1>hi</h1>')],
    ['security.json', text('{}')],
  ]);
}

describe('securitySchema (§6)', () => {
  it('accepts a valid security document', () => {
    const doc = {
      security: {
        integrityChecks: {
          checksumAlgorithm: 'SHA-256',
          checksums: { 'content/index.html': 'a'.repeat(64) },
        },
        digitalSignatures: { publicKey: 'PEM', signatureFile: 'signature.sig' },
      },
    };
    expect(parseSecurity(doc)).toEqual(doc);
  });

  it('rejects non-hex checksums', () => {
    expect(() =>
      securitySchema.parse({
        security: {
          integrityChecks: { checksumAlgorithm: 'SHA-256', checksums: { 'a.txt': 'zz' } },
        },
      }),
    ).toThrow();
  });

  it('rejects unsupported algorithms', () => {
    expect(() =>
      securitySchema.parse({
        security: { integrityChecks: { checksumAlgorithm: 'MD5', checksums: {} } },
      }),
    ).toThrow();
  });
});

describe('computeChecksums / buildSecurity', () => {
  it('covers every file except security.json, sorted', async () => {
    const checksums = await computeChecksums(fixtureFiles(), hashProvider);
    expect(Object.keys(checksums)).toEqual(['content/index.html', 'metadata.json']);
    expect(checksums['content/index.html']).toMatch(/^[0-9a-f]{64}$/);
  });

  it('builds a security model with real SHA-256 digests', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    expect(security.security.integrityChecks.checksumAlgorithm).toBe('SHA-256');
    const indexBytes = files.get('content/index.html');
    expect(indexBytes).toBeDefined();
    if (indexBytes !== undefined) {
      expect(security.security.integrityChecks.checksums['content/index.html']).toBe(
        await hashProvider.digestHex(indexBytes),
      );
    }
  });
});

describe('verifyIntegrity', () => {
  it('reports valid for an untampered package', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    const report = await verifyIntegrity(files, security, hashProvider);
    expect(report.valid).toBe(true);
    expect(report.issues).toEqual([]);
  });

  it('detects a tampered file as checksum-mismatch', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    files.set('content/index.html', text('<h1>evil</h1>'));
    const report = await verifyIntegrity(files, security, hashProvider);
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: 'checksum-mismatch', path: 'content/index.html' }),
    ]);
  });

  it('detects a removed file as missing-file', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    files.delete('metadata.json');
    const report = await verifyIntegrity(files, security, hashProvider);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: 'missing-file', path: 'metadata.json' }),
    ]);
  });

  it('detects an added file as uncovered-file', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    files.set('content/sneaky.js', text('alert(1)'));
    const report = await verifyIntegrity(files, security, hashProvider);
    expect(report.issues).toEqual([
      expect.objectContaining({ kind: 'uncovered-file', path: 'content/sneaky.js' }),
    ]);
  });

  it('reports missing-security-file when security.json is absent', async () => {
    const report = await verifyIntegrity(fixtureFiles(), undefined, hashProvider);
    expect(report.valid).toBe(false);
    expect(report.issues).toEqual([{ kind: 'missing-security-file' }]);
  });
});
