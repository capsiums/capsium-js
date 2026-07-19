import { describe, expect, it, afterAll } from 'vitest';
import { CliUsageError, parseCliArgs, startServer, DEFAULT_PORT } from '../src/index.js';
import { cleanupFixtures, json, text, writePackageDir } from './fixtures.js';

afterAll(cleanupFixtures);

const demoFiles = (): Map<string, Uint8Array> =>
  new Map([
    [
      'metadata.json',
      json({
        name: 'cli-demo',
        version: '1.0.0',
        description: 'CLI fixture',
        guid: 'https://example.com/cli-demo',
        uuid: '123e4567-e89b-12d3-a456-426614174000',
      }),
    ],
    ['content/index.html', text('<!doctype html><h1>CLI</h1>')],
  ]);

describe('parseCliArgs', () => {
  it('parses a bare package path with defaults', () => {
    expect(parseCliArgs(['pkg.cap'])).toEqual({ packagePath: 'pkg.cap', port: DEFAULT_PORT });
  });

  it('parses --port, --store and --cache-control', () => {
    expect(
      parseCliArgs(['dir', '--port', '0', '--store', '/tmp/store', '--cache-control', 'no-cache']),
    ).toEqual({ packagePath: 'dir', port: 0, store: '/tmp/store', cacheControl: 'no-cache' });
  });

  it('rejects a missing package path', () => {
    expect(() => parseCliArgs([])).toThrow(CliUsageError);
  });

  it('rejects unknown options and extra positionals', () => {
    expect(() => parseCliArgs(['pkg.cap', '--nope'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['a.cap', 'b.cap'])).toThrow(CliUsageError);
  });

  it('rejects missing option values and invalid ports', () => {
    expect(() => parseCliArgs(['pkg.cap', '--port'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['pkg.cap', '--port', 'abc'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['pkg.cap', '--port', '-1'])).toThrow(CliUsageError);
    expect(() => parseCliArgs(['pkg.cap', '--store'])).toThrow(CliUsageError);
  });
});

describe('startServer', () => {
  it('serves the package over node:http on an ephemeral port', async () => {
    const running = await startServer({
      packagePath: await writePackageDir(demoFiles()),
      port: 0,
    });
    try {
      expect(running.port).toBeGreaterThan(0);
      const response = await fetch(`${running.url}/`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('<!doctype html><h1>CLI</h1>');
      const metadata = await fetch(`${running.url}/api/v1/introspect/metadata`);
      expect(metadata.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        running.server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
