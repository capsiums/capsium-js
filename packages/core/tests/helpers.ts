import type { HashProvider } from '../src/index.js';

/** Real SHA-256 via Node's WebCrypto global — keeps core isomorphic. */
export class TestHashProvider implements HashProvider {
  readonly algorithm = 'SHA-256' as const;

  async digestHex(data: Uint8Array): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
}

export function text(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function json(value: unknown): Uint8Array {
  return text(JSON.stringify(value));
}

export const validMetadata = {
  name: 'story-of-claire',
  version: '1.0.0',
  description: 'A sample package',
  guid: 'https://github.com/capsiums/cap-story',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  author: 'Ribose',
  license: 'MIT',
  repository: { type: 'git', url: 'https://github.com/capsiums/cap-story.git' },
  dependencies: { 'capsium://example.com/other-pkg': '>=1.0.0' },
  readOnly: true,
} as const;
