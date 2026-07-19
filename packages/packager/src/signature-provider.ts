/**
 * RSA-SHA256 SignatureProvider backed by node:crypto (RSASSA-PKCS1-v1_5,
 * openssl `dgst -sha256` compatible). Public keys may be raw PEM (SPKI) or
 * X.509 certificate PEMs — certificates are unwrapped to their public key.
 */
import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  X509Certificate,
  type KeyObject,
} from 'node:crypto';
import { SignatureError, type SignatureProvider } from '@capsium/core';

/** Minimum RSA modulus accepted for signing (05x-packaging). */
export const MIN_RSA_KEY_BITS = 2048;

function privateKeyFromPem(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (error) {
    throw new SignatureError('cannot load private key', { cause: error });
  }
  if (key.asymmetricKeyType !== 'rsa') {
    throw new SignatureError('private key is not an RSA key');
  }
  const bits = key.asymmetricKeyDetails?.modulusLength;
  if (bits !== undefined && bits < MIN_RSA_KEY_BITS) {
    throw new SignatureError(`RSA key too short: minimum ${MIN_RSA_KEY_BITS} bits required`);
  }
  return key;
}

function publicKeyFromPem(pem: string): KeyObject {
  try {
    if (pem.includes('BEGIN CERTIFICATE')) {
      return new X509Certificate(pem).publicKey;
    }
    return createPublicKey(pem);
  } catch (error) {
    throw new SignatureError('cannot load public key or certificate', { cause: error });
  }
}

export class NodeSignatureProvider implements SignatureProvider {
  readonly algorithm = 'RSA-SHA256' as const;

  sign(payload: Uint8Array, privateKeyPem: string): Promise<Uint8Array> {
    const key = privateKeyFromPem(privateKeyPem);
    return Promise.resolve(cryptoSign('sha256', payload, key));
  }

  verify(payload: Uint8Array, signature: Uint8Array, publicKeyPem: string): Promise<boolean> {
    const key = publicKeyFromPem(publicKeyPem);
    return Promise.resolve(cryptoVerify('sha256', payload, key, signature));
  }
}
