/**
 * Encryption envelope model (ARCHITECTURE.md §6b). Isomorphic — only the
 * schema and base64 helpers live here; the AES-256-GCM / RSA-OAEP-SHA256
 * crypto is implemented per platform (currently `@capsium/packager` via
 * node:crypto).
 *
 * Encrypted `.cap` zip layout (per 05x-packaging):
 *
 *   metadata.json    # cleartext
 *   signature.json   # cleartext envelope (this model)
 *   package.enc      # AES-256-GCM ciphertext of the inner zip
 *
 * The DEK is 32 random bytes wrapped with the recipient's RSA public key
 * (OAEP, SHA-256, MGF1-SHA256). OpenPGP is out of scope.
 */
import { z } from 'zod';

/** Name of the encrypted inner-zip payload inside an encrypted .cap. */
export const ENCRYPTED_PACKAGE_FILE = 'package.enc';

/** Name of the cleartext encryption envelope inside an encrypted .cap. */
export const ENCRYPTION_ENVELOPE_FILE = 'signature.json';

export const GCM_IV_BYTES = 12;
export const GCM_AUTH_TAG_BYTES = 16;
export const DEK_BYTES = 32;

export const encryptionEnvelopeSchema = z.object({
  encryption: z.object({
    algorithm: z.literal('AES-256-GCM'),
    keyManagement: z.literal('RSA-OAEP-SHA256'),
    /** Base64 RSA-OAEP-SHA256-wrapped data-encryption-key. */
    encryptedDek: z.string().min(1),
    /** Base64 12-byte GCM IV. */
    iv: z.string().min(1),
    /** Base64 16-byte GCM auth tag. */
    authTag: z.string().min(1),
  }),
});
export type EncryptionEnvelope = z.infer<typeof encryptionEnvelopeSchema>;

export function parseEncryptionEnvelope(input: unknown): EncryptionEnvelope {
  return encryptionEnvelopeSchema.parse(input);
}

/** True when a package file map has the §6b encrypted layout. */
export function isEncryptedPackage(files: ReadonlyMap<string, Uint8Array>): boolean {
  return files.has(ENCRYPTED_PACKAGE_FILE) && files.has(ENCRYPTION_ENVELOPE_FILE);
}

/** Isomorphic base64 encode (btoa exists in Node >= 16 and browsers). */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Isomorphic base64 decode. */
export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
