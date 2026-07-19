/**
 * RSA-SHA256 SignatureProvider backed by WebCrypto (SubtleCrypto
 * RSASSA-PKCS1-v1_5 with SHA-256) — available in workerd.
 *
 * Mirrors @capsium/swsws's WebCryptoSignatureProvider (duplicated here
 * because the swsws public entry transitively pulls node:crypto via
 * bcryptjs, which cannot be bundled for the Workers runtime). Private
 * keys are imported as PKCS#8, public keys as SPKI; X.509 certificate
 * PEMs are NOT supported by WebCrypto (use the raw public key PEM).
 */
import { SignatureError, type SignatureProvider } from '@capsium/core';

const ALGORITHM = 'RSASSA-PKCS1-v1_5' as const;

function pemToDer(pem: string, label: string): Uint8Array {
  const match = pem.match(
    new RegExp(`-----BEGIN ${label}-----([A-Za-z0-9+/=\\r\\n]+)-----END ${label}-----`),
  );
  if (match?.[1] === undefined) {
    if (pem.includes('BEGIN CERTIFICATE')) {
      throw new SignatureError(
        'X.509 certificates are not supported by WebCrypto; embed the raw public key PEM',
      );
    }
    throw new SignatureError(`cannot parse PEM block: ${label}`);
  }
  const base64 = match[1].replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = globalThis.atob(base64);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    der[i] = binary.charCodeAt(i);
  }
  return der;
}

export class WebCryptoSignatureProvider implements SignatureProvider {
  readonly algorithm = 'RSA-SHA256' as const;

  constructor(private readonly subtle: SubtleCrypto = globalThis.crypto.subtle) {}

  async sign(payload: Uint8Array, privateKeyPem: string): Promise<Uint8Array> {
    let key: CryptoKey;
    try {
      key = await this.subtle.importKey(
        'pkcs8',
        pemToDer(privateKeyPem, 'PRIVATE KEY') as BufferSource,
        { name: ALGORITHM, hash: 'SHA-256' },
        false,
        ['sign'],
      );
    } catch (error) {
      if (error instanceof SignatureError) {
        throw error;
      }
      throw new SignatureError('cannot load private key', { cause: error });
    }
    const signature = await this.subtle.sign(ALGORITHM, key, payload as BufferSource);
    return new Uint8Array(signature);
  }

  async verify(payload: Uint8Array, signature: Uint8Array, publicKeyPem: string): Promise<boolean> {
    let key: CryptoKey;
    try {
      key = await this.subtle.importKey(
        'spki',
        pemToDer(publicKeyPem, 'PUBLIC KEY') as BufferSource,
        { name: ALGORITHM, hash: 'SHA-256' },
        false,
        ['verify'],
      );
    } catch (error) {
      if (error instanceof SignatureError) {
        throw error;
      }
      throw new SignatureError('cannot load public key', { cause: error });
    }
    return await this.subtle.verify(
      ALGORITHM,
      key,
      signature as BufferSource,
      payload as BufferSource,
    );
  }
}
