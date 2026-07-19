import { beforeAll, describe, expect, it } from 'vitest';
import {
  assertPackageSignature,
  buildSecurity,
  buildSignedPayload,
  isPackageSigned,
  SIGNATURE_FILE,
  SIGNATURE_PUBLIC_KEY_FILE,
  SignatureError,
  SignatureMismatchError,
  UnsignedPackageError,
  verifyPackageSignature,
  withDigitalSignatures,
  type Security,
  type SignatureProvider,
} from '../src/index.js';
import { TestHashProvider, text } from './helpers.js';

const hashProvider = new TestHashProvider();

/** WebCrypto-backed provider (Node's global subtle) — keeps core isomorphic. */
class TestSignatureProvider implements SignatureProvider {
  readonly algorithm = 'RSA-SHA256' as const;

  constructor(
    private readonly subtle: (typeof globalThis.crypto)['subtle'] = globalThis.crypto.subtle,
  ) {}

  async sign(payload: Uint8Array, privateKeyPem: string): Promise<Uint8Array> {
    const key = await this.subtle.importKey(
      'pkcs8',
      pemToDer(privateKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    return new Uint8Array(await this.subtle.sign('RSASSA-PKCS1-v1_5', key, payload));
  }

  async verify(payload: Uint8Array, signature: Uint8Array, publicKeyPem: string): Promise<boolean> {
    const key = await this.subtle.importKey(
      'spki',
      pemToDer(publicKeyPem),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    return await this.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, payload);
  }
}

function pemToDer(pem: string): Uint8Array {
  const base64 = pem.replace(/-----[A-Z ]+-----/g, '').replace(/\s/g, '');
  const binary = atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    der[i] = binary.charCodeAt(i);
  }
  return der;
}

function derToPem(der: ArrayBuffer, label: string): string {
  const bytes = new Uint8Array(der);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const base64 = btoa(binary);
  const lines = base64.match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

const provider = new TestSignatureProvider();
let privateKeyPem: string;
let publicKeyPem: string;

beforeAll(async () => {
  const subtle = globalThis.crypto.subtle;
  const pair = await subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  privateKeyPem = derToPem(await subtle.exportKey('pkcs8', pair.privateKey), 'PRIVATE KEY');
  publicKeyPem = derToPem(await subtle.exportKey('spki', pair.publicKey), 'PUBLIC KEY');
});

function fixtureFiles(): Map<string, Uint8Array> {
  return new Map([
    ['metadata.json', text('{"name":"x"}')],
    ['content/index.html', text('<h1>hi</h1>')],
    ['content/styles.css', text('body {}')],
  ]);
}

async function signedFixture(): Promise<{ files: Map<string, Uint8Array>; security: Security }> {
  const files = fixtureFiles();
  const security = withDigitalSignatures(await buildSecurity(files, hashProvider));
  files.set('security.json', text(JSON.stringify(security)));
  files.set(SIGNATURE_PUBLIC_KEY_FILE, text(publicKeyPem));
  const signature = await provider.sign(buildSignedPayload(files, security), privateKeyPem);
  files.set(SIGNATURE_FILE, signature);
  return { files, security };
}

describe('buildSignedPayload (§6a)', () => {
  it('concatenates checksum-covered file bytes in sorted key order', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    const payload = buildSignedPayload(files, security);
    const expected = new Uint8Array([
      ...files.get('content/index.html')!,
      ...files.get('content/styles.css')!,
      ...files.get('metadata.json')!,
    ]);
    expect(payload).toEqual(expected);
  });

  it('throws SignatureError when a covered file is missing', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    files.delete('metadata.json');
    expect(() => buildSignedPayload(files, security)).toThrow(SignatureError);
  });
});

describe('withDigitalSignatures / isPackageSigned', () => {
  it('attaches the digitalSignatures block with §6a defaults', async () => {
    const security = withDigitalSignatures(await buildSecurity(fixtureFiles(), hashProvider));
    expect(security.security.digitalSignatures).toEqual({
      publicKey: SIGNATURE_PUBLIC_KEY_FILE,
      signatureFile: SIGNATURE_FILE,
    });
    expect(isPackageSigned(security)).toBe(true);
  });
});

describe('verifyPackageSignature / assertPackageSignature', () => {
  it('verifies a freshly signed package with the embedded key', async () => {
    const { files, security } = await signedFixture();
    await expect(verifyPackageSignature(files, security, provider)).resolves.toBe(true);
    await expect(assertPackageSignature(files, security, provider)).resolves.toBeUndefined();
  });

  it('verifies with an explicit public key override', async () => {
    const { files, security } = await signedFixture();
    files.delete(SIGNATURE_PUBLIC_KEY_FILE);
    await expect(
      verifyPackageSignature(files, security, provider, publicKeyPem),
    ).resolves.toBe(true);
  });

  it('returns false / throws SignatureMismatchError for tampered content', async () => {
    const { files, security } = await signedFixture();
    files.set('content/index.html', text('<h1>evil</h1>'));
    await expect(verifyPackageSignature(files, security, provider)).resolves.toBe(false);
    await expect(assertPackageSignature(files, security, provider)).rejects.toThrow(
      SignatureMismatchError,
    );
  });

  it('returns false for a tampered signature', async () => {
    const { files, security } = await signedFixture();
    const signature = new Uint8Array(files.get(SIGNATURE_FILE)!);
    signature[0] = (signature[0] ?? 0) ^ 0xff;
    files.set(SIGNATURE_FILE, signature);
    await expect(verifyPackageSignature(files, security, provider)).resolves.toBe(false);
  });

  it('throws UnsignedPackageError when no digitalSignatures are declared', async () => {
    const files = fixtureFiles();
    const security = await buildSecurity(files, hashProvider);
    expect(isPackageSigned(security)).toBe(false);
    await expect(verifyPackageSignature(files, security, provider)).rejects.toThrow(
      UnsignedPackageError,
    );
  });

  it('throws SignatureError when the signature file is missing', async () => {
    const { files, security } = await signedFixture();
    files.delete(SIGNATURE_FILE);
    await expect(verifyPackageSignature(files, security, provider)).rejects.toThrow(SignatureError);
  });

  it('throws SignatureError when the embedded public key is missing', async () => {
    const { files, security } = await signedFixture();
    files.delete(SIGNATURE_PUBLIC_KEY_FILE);
    await expect(verifyPackageSignature(files, security, provider)).rejects.toThrow(SignatureError);
  });
});
