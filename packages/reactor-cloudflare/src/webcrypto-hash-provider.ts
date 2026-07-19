/**
 * SHA-256 HashProvider backed by WebCrypto (crypto.subtle).
 *
 * Mirrors @capsium/swsws's WebCryptoHashProvider (duplicated here because
 * the swsws public entry transitively pulls node:crypto via bcryptjs,
 * which cannot be bundled for the Workers runtime).
 */
import type { HashProvider } from '@capsium/core';

export class WebCryptoHashProvider implements HashProvider {
  readonly algorithm = 'SHA-256' as const;

  constructor(private readonly subtle: SubtleCrypto = globalThis.crypto.subtle) {}

  async digestHex(data: Uint8Array): Promise<string> {
    const digest = await this.subtle.digest('SHA-256', data as BufferSource);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}
