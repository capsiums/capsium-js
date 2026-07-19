/**
 * Hash provider abstraction. Core declares the interface and the
 * compute/verify logic; implementations live in consumers
 * (`@capsium/packager` uses node:crypto, `@capsium/swsws` uses WebCrypto).
 */
export interface HashProvider {
  readonly algorithm: 'SHA-256';
  /** Lowercase hex digest of `data`. */
  digestHex(data: Uint8Array): Promise<string>;
}
