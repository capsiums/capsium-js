/**
 * SHA-256 HashProvider backed by node:crypto.
 */
import { createHash } from 'node:crypto';
import type { HashProvider } from '@capsium/core';

export class NodeHashProvider implements HashProvider {
  readonly algorithm = 'SHA-256' as const;

  digestHex(data: Uint8Array): Promise<string> {
    return Promise.resolve(createHash('sha256').update(data).digest('hex'));
  }
}
