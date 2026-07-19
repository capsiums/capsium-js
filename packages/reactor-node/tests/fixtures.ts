/**
 * Shared test fixtures: in-memory package file maps, temp package dirs and
 * a supertest-style ephemeral-port server around a ReactorHandler.
 */
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { ReactorHandler } from '../src/index.js';

export const text = (value: string): Uint8Array => new TextEncoder().encode(value);
export const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

/** Temp dirs created by this test run (removed in cleanup). */
const createdDirs: string[] = [];

export async function writePackageDir(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capsium-reactor-node-'));
  createdDirs.push(dir);
  for (const [path, bytes] of files) {
    const full = join(dir, ...path.split('/'));
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, bytes);
  }
  return dir;
}

export async function writeTempFile(bytes: Uint8Array): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'capsium-reactor-node-'));
  createdDirs.push(dir);
  const file = join(dir, 'package.cap');
  await writeFile(file, bytes);
  return file;
}

export async function cleanupFixtures(): Promise<void> {
  await Promise.all(createdDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  createdDirs.length = 0;
}

export interface TestResponse {
  readonly status: number;
  readonly headers: globalThis.Headers;
  readonly body: string;
}

/** Run requests against a real node:http server on an ephemeral port. */
export async function withServer(
  handler: ReactorHandler,
  run: (request: (path: string, method?: string) => Promise<TestResponse>, baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;
  const request = async (path: string, method = 'GET'): Promise<TestResponse> => {
    const response = await fetch(`${baseUrl}${path}`, { method });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };
  try {
    await run(request, baseUrl);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
  }
}
