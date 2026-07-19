import { beforeAll, describe, expect, it } from 'vitest';
import { zipSync } from 'fflate';
import { createPrivateKey, createPublicKey, sign as nodeSign, generateKeyPairSync } from 'node:crypto';
import {
  buildSecurity,
  buildSignedPayload,
  SIGNATURE_FILE,
  SIGNATURE_PUBLIC_KEY_FILE,
  withDigitalSignatures,
} from '@capsium/core';
import {
  PackageSignatureError,
  PackageStore,
  type KeyValueBlobCache,
} from '../src/package-store.js';
import { WebCryptoHashProvider } from '../src/webcrypto-hash-provider.js';
import { WebCryptoSignatureProvider } from '../src/webcrypto-signature-provider.js';

const text = (value: string): Uint8Array => new TextEncoder().encode(value);
const json = (value: unknown): Uint8Array => text(JSON.stringify(value));

class MemoryBlobCache implements KeyValueBlobCache {
  private readonly blobs = new Map<string, Uint8Array>();

  put(key: string, data: Uint8Array): Promise<void> {
    this.blobs.set(key, data);
    return Promise.resolve();
  }

  get(key: string): Promise<Uint8Array | undefined> {
    return Promise.resolve(this.blobs.get(key));
  }

  delete(key: string): Promise<void> {
    this.blobs.delete(key);
    return Promise.resolve();
  }
}

const hashProvider = new WebCryptoHashProvider();
const signatureProvider = new WebCryptoSignatureProvider();

const metadata = {
  name: 'signed-sw-pkg',
  version: '1.0.0',
  description: 'SW signature fixture',
  guid: 'https://example.com/signed-sw-pkg',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
};

function derToPem(der: ArrayBuffer, label: string): string {
  let binary = '';
  for (const byte of new Uint8Array(der)) {
    binary += String.fromCharCode(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  );
  privateKeyPem = derToPem(await subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
  publicKeyPem = derToPem(await subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY');
});

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', json(metadata)],
    ['content/index.html', text('<!doctype html><h1>Signed SW</h1>')],
  ]);
}

/** Sign a fixture file map the way @capsium/packager's PackageSigner does. */
async function signFiles(files: Map<string, Uint8Array>): Promise<Map<string, Uint8Array>> {
  const out = new Map(files);
  out.set(SIGNATURE_PUBLIC_KEY_FILE, text(publicKeyPem));
  const security = withDigitalSignatures(await buildSecurity(out, hashProvider));
  out.set('security.json', json(security));
  out.set(SIGNATURE_FILE, await signatureProvider.sign(buildSignedPayload(out, security), privateKeyPem));
  return out;
}

async function capOf(files: Map<string, Uint8Array>): Promise<Uint8Array> {
  return zipSync(Object.fromEntries(files));
}

describe('WebCryptoSignatureProvider', () => {
  it('round-trips sign/verify with WebCrypto-generated keys', async () => {
    const payload = text('payload');
    const signature = await signatureProvider.sign(payload, privateKeyPem);
    await expect(signatureProvider.verify(payload, signature, publicKeyPem)).resolves.toBe(true);
    await expect(
      signatureProvider.verify(text('other'), signature, publicKeyPem),
    ).resolves.toBe(false);
  });

  it('verifies signatures produced by node:crypto (openssl-compatible)', async () => {
    // Node keys (pkcs8/spki PEM) signed via node:crypto — the same
    // RSASSA-PKCS1-v1_5 SHA-256 construction openssl and the Ruby gem use.
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const payload = text('cross-provider payload');
    const signature = nodeSign('sha256', payload, createPrivateKey(privateKey));
    await expect(signatureProvider.verify(payload, signature, publicKey)).resolves.toBe(true);
    // Sanity: node:crypto also accepts the WebCrypto provider's output.
    const webSig = await signatureProvider.sign(payload, privateKeyPem);
    const { verify: nodeVerify } = await import('node:crypto');
    expect(nodeVerify('sha256', payload, createPublicKey(publicKeyPem), webSig)).toBe(true);
  });

  it('rejects X.509 certificate PEMs with a clear error', async () => {
    const certPem = `-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n`;
    await expect(signatureProvider.verify(text('x'), text('y'), certPem)).rejects.toThrow(
      'X.509 certificates are not supported by WebCrypto',
    );
  });
});

describe('PackageStore signature gate (§6a)', () => {
  it('installs a package whose declared signature verifies', async () => {
    const store = new PackageStore(new MemoryBlobCache(), hashProvider, signatureProvider);
    const installed = await store.install(await capOf(await signFiles(fixtureFiles())));
    expect(installed.model.metadata.name).toBe('signed-sw-pkg');
    expect(installed.validity.valid).toBe(true);
  });

  it('rejects a package whose content was tampered after signing', async () => {
    const files = await signFiles(fixtureFiles());
    files.set('content/index.html', text('<h1>tampered</h1>'));
    const store = new PackageStore(new MemoryBlobCache(), hashProvider, signatureProvider);
    await expect(store.install(await capOf(files))).rejects.toThrow(PackageSignatureError);
    expect(store.current).toBeUndefined();
  });

  it('rejects a signed package when no SignatureProvider is configured', async () => {
    const store = new PackageStore(new MemoryBlobCache(), hashProvider);
    await expect(store.install(await capOf(await signFiles(fixtureFiles())))).rejects.toThrow(
      PackageSignatureError,
    );
  });
});
