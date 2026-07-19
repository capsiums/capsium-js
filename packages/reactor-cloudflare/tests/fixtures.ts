/**
 * Test fixtures: .cap archives built programmatically with fflate and
 * node:crypto/WebCrypto — the same approach as the swsws test suite.
 *
 * - `mainCap()` — a single-layer package: dual HTML routes, an explicit
 *   manifest (MIME source), a styles route with a Cache-Control override,
 *   a JSON dataset and a (501) handler route.
 * - `layeredCap()` — a §5a layered package: everything lives in the bottom
 *   `base` layer; the top `updates` layer tombstones content/legacy.html.
 * - `signedCap()` — the main package with a §6a RSA-SHA256 signature.
 */
import { generateKeyPairSync } from 'node:crypto';
import { zipSync } from 'fflate';
import {
  buildSecurity,
  buildSignedPayload,
  withDigitalSignatures,
  SIGNATURE_FILE,
  SIGNATURE_PUBLIC_KEY_FILE,
  type Security,
} from '@capsium/core';
import { WebCryptoHashProvider } from '../src/webcrypto-hash-provider.js';
import { WebCryptoSignatureProvider } from '../src/webcrypto-signature-provider.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

const hashProvider = new WebCryptoHashProvider();

export const INDEX_HTML = '<!doctype html><h1>CF Demo</h1>';
export const ABOUT_HTML = '<!doctype html><h1>About CF Demo</h1>';
export const ANIMALS_JSON = JSON.stringify([{ name: 'fox' }]);

const mainMetadata = {
  name: 'cf-demo-pkg',
  version: '1.0.0',
  description: 'Cloudflare reactor fixture',
  guid: 'https://example.com/cf-demo-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  author: 'Capsium',
};

export function mainFixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json(mainMetadata)],
    [
      'manifest.json',
      json({
        resources: {
          'content/index.html': { type: 'text/html', visibility: 'exported' },
          'content/about.html': { type: 'text/html', visibility: 'exported' },
          'content/styles.css': { type: 'text/css', visibility: 'exported' },
        },
      }),
    ],
    [
      'routes.json',
      json({
        index: 'content/index.html',
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/index', resource: 'content/index.html' },
          { path: '/index.html', resource: 'content/index.html' },
          { path: '/about', resource: 'content/about.html' },
          { path: '/about.html', resource: 'content/about.html' },
          {
            path: '/styles.css',
            resource: 'content/styles.css',
            headers: { 'Cache-Control': 'public, max-age=60' },
          },
          { path: '/api/v1/data/animals', dataset: 'animals' },
          { path: '/api/hello', method: 'GET', handler: 'handlers/hello.js' },
        ],
      }),
    ],
    [
      'storage.json',
      json({ storage: { dataSets: { animals: { source: 'data/animals.json' } } } }),
    ],
    ['content/index.html', text(INDEX_HTML)],
    ['content/about.html', text(ABOUT_HTML)],
    ['content/styles.css', text('body { color: teal; }')],
    ['data/animals.json', text(ANIMALS_JSON)],
    ['handlers/hello.js', text('export default { fetch: (request) => new Response("hi") };')],
  ]);
}

const layeredMetadata = {
  name: 'cf-layered-pkg',
  version: '1.0.0',
  description: 'Cloudflare layered fixture',
  guid: 'https://example.com/cf-layered-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174001',
};

export const LAYERED_INDEX_HTML = '<!doctype html><h1>Layered CF Demo</h1>';

export function layeredFixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json(layeredMetadata)],
    [
      'routes.json',
      json({
        index: 'content/index.html',
        routes: [
          { path: '/', resource: 'content/index.html' },
          { path: '/legacy', resource: 'content/legacy.html' },
        ],
      }),
    ],
    [
      'storage.json',
      json({
        storage: {
          layers: [
            { path: 'base', writable: false },
            { path: 'updates', writable: true },
          ],
        },
      }),
    ],
    ['base/index.html', text(LAYERED_INDEX_HTML)],
    ['base/legacy.html', text('<p>legacy</p>')],
    ['updates/.capsium-tombstones', json(['legacy.html'])],
  ]);
}

/** Zip the files into a .cap with a §6 security.json; optionally tamper afterwards. */
export async function packCap(files: Map<string, Uint8Array>, tamper = false): Promise<Uint8Array> {
  const out = new Map(files);
  const security = await buildSecurity(out, hashProvider);
  out.set('security.json', json(security));
  if (tamper) {
    out.set('content/index.html', text('<h1>tampered</h1>'));
  }
  return zipSync(Object.fromEntries(out));
}

export async function mainCap(): Promise<Uint8Array> {
  return await packCap(mainFixtureFiles());
}

export async function layeredCap(): Promise<Uint8Array> {
  return await packCap(layeredFixtureFiles());
}

export interface SigningKeyPair {
  readonly privateKeyPem: string;
  readonly publicKeyPem: string;
}

export function generateSigningKeys(): SigningKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { privateKeyPem: privateKey, publicKeyPem: publicKey };
}

/**
 * The main package with a §6a digital signature (signature over the
 * checksum-covered payload, WebCrypto-signable PKCS#8 key). With
 * `breakSignature` the signature signs different bytes (mismatch).
 */
export async function signedCap(keys: SigningKeyPair, breakSignature = false): Promise<Uint8Array> {
  const out = mainFixtureFiles();
  out.set(SIGNATURE_PUBLIC_KEY_FILE, text(keys.publicKeyPem));
  const security: Security = withDigitalSignatures(await buildSecurity(out, hashProvider));
  out.set('security.json', json(security));
  const payload = breakSignature
    ? text('not the package payload')
    : buildSignedPayload(out, security);
  const signature = await new WebCryptoSignatureProvider().sign(payload, keys.privateKeyPem);
  out.set(SIGNATURE_FILE, signature);
  return zipSync(Object.fromEntries(out));
}
