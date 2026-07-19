/**
 * Digital signatures (ARCHITECTURE.md §6a) — RSA-SHA256 over the canonical
 * signed payload. Isomorphic: the crypto primitives are injected via
 * `SignatureProvider` (`@capsium/packager` uses node:crypto,
 * `@capsium/swsws` uses WebCrypto RSASSA-PKCS1-v1_5 SHA-256).
 *
 * Signed payload construction (identical in every implementation): take the
 * keys of `security.integrityChecks.checksums` in sorted order, concatenate
 * the bytes of each referenced file in that order. Sign/verify that byte
 * stream with RSA-SHA256 (openssl interop:
 * `openssl dgst -sha256 -sign/-verify`). The construction matches the Ruby
 * gem's `Capsium::Package::Signer` exactly.
 */
import { CapsiumError } from './errors.js';
import type { Security } from './security.js';

/** Default package-relative name of the raw RSA-SHA256 signature file. */
export const SIGNATURE_FILE = 'signature.sig';

/** Default package-relative name of the embedded public key (or X.509 cert) PEM. */
export const SIGNATURE_PUBLIC_KEY_FILE = 'signature.pub.pem';

/** RSA-SHA256 crypto primitives, implemented per platform. */
export interface SignatureProvider {
  readonly algorithm: 'RSA-SHA256';
  /** Raw RSA-SHA256 (PKCS#1 v1.5) signature over `payload`. */
  sign(payload: Uint8Array, privateKeyPem: string): Promise<Uint8Array>;
  /** True when `signature` matches `payload` under `publicKeyPem` (PEM or X.509 cert). */
  verify(payload: Uint8Array, signature: Uint8Array, publicKeyPem: string): Promise<boolean>;
}

/** Structural problems: missing signature/key files, unloadable keys, uncovered payload files. */
export class SignatureError extends CapsiumError {}

/** A signature is declared but does not match the package contents. */
export class SignatureMismatchError extends SignatureError {}

/** Signature operations requested on a package that declares no digitalSignatures. */
export class UnsignedPackageError extends SignatureError {}

/** True when security.json declares a digitalSignatures block. */
export function isPackageSigned(security: Security): boolean {
  return security.security.digitalSignatures !== undefined;
}

const decoder = new TextDecoder();

function sortedPaths(paths: Iterable<string>): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The canonical §6a signed payload: the concatenation, in sorted
 * package-relative path order, of the bytes of every file covered by the
 * integrity checksums. Throws SignatureError when a covered file is missing.
 */
export function buildSignedPayload(
  files: ReadonlyMap<string, Uint8Array>,
  security: Security,
): Uint8Array {
  const { checksums } = security.security.integrityChecks;
  const paths = sortedPaths(Object.keys(checksums));
  let total = 0;
  const chunks: Uint8Array[] = [];
  for (const path of paths) {
    const bytes = files.get(path);
    if (bytes === undefined) {
      throw new SignatureError(`file covered by checksums is missing: ${path}`);
    }
    chunks.push(bytes);
    total += bytes.byteLength;
  }
  const payload = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return payload;
}

/** Return `security` with the digitalSignatures block attached (defaults per §6a). */
export function withDigitalSignatures(
  security: Security,
  publicKey: string = SIGNATURE_PUBLIC_KEY_FILE,
  signatureFile: string = SIGNATURE_FILE,
): Security {
  return {
    security: {
      ...security.security,
      digitalSignatures: { publicKey, signatureFile },
    },
  };
}

/**
 * Verify the declared digital signature against the package contents.
 * Returns false on mismatch (a mismatch is data, not an exception — callers
 * that reject use `assertPackageSignature`). Without an explicit
 * `publicKeyPem` the embedded key declared in security.json is used.
 * Throws UnsignedPackageError when unsigned and SignatureError on
 * structural problems.
 */
export async function verifyPackageSignature(
  files: ReadonlyMap<string, Uint8Array>,
  security: Security,
  provider: SignatureProvider,
  publicKeyPem?: string,
): Promise<boolean> {
  const declared = security.security.digitalSignatures;
  if (declared === undefined) {
    throw new UnsignedPackageError(
      'package is not signed (security.json declares no digitalSignatures)',
    );
  }
  const signature = files.get(declared.signatureFile);
  if (signature === undefined) {
    throw new SignatureError(`signature file missing: ${declared.signatureFile}`);
  }
  let pem = publicKeyPem;
  if (pem === undefined) {
    const keyBytes = files.get(declared.publicKey);
    if (keyBytes === undefined) {
      throw new SignatureError(`public key file missing: ${declared.publicKey}`);
    }
    pem = decoder.decode(keyBytes);
  }
  const payload = buildSignedPayload(files, security);
  return await provider.verify(payload, signature, pem);
}

/** Verify the declared signature and throw SignatureMismatchError on mismatch. */
export async function assertPackageSignature(
  files: ReadonlyMap<string, Uint8Array>,
  security: Security,
  provider: SignatureProvider,
  publicKeyPem?: string,
): Promise<void> {
  if (!(await verifyPackageSignature(files, security, provider, publicKeyPem))) {
    throw new SignatureMismatchError('digital signature does not match the package contents');
  }
}
