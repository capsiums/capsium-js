/**
 * security.json model (ARCHITECTURE.md §6) — pack-time integrity data.
 *
 * Checksums cover EVERY file in the package except `security.json` itself
 * and `signature.sig`. Reactors/loaders MUST verify SHA-256 checksums when
 * security.json is present and REJECT the package on mismatch. The
 * digitalSignatures block is acted upon by the signature logic in
 * `signatures.ts` (§6a).
 */
import { z } from 'zod';

export const SECURITY_FILE = 'security.json';

export const checksumAlgorithmSchema = z.enum(['SHA-256']);
export type ChecksumAlgorithm = z.infer<typeof checksumAlgorithmSchema>;

export const integrityChecksSchema = z.object({
  checksumAlgorithm: checksumAlgorithmSchema,
  /** Package-relative POSIX path -> lowercase hex digest. */
  checksums: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 hex digest')),
});
export type IntegrityChecks = z.infer<typeof integrityChecksSchema>;

export const digitalSignaturesSchema = z.object({
  publicKey: z.string().min(1),
  signatureFile: z.string().min(1),
});
export type DigitalSignatures = z.infer<typeof digitalSignaturesSchema>;

export const securitySchema = z.object({
  security: z.object({
    integrityChecks: integrityChecksSchema,
    digitalSignatures: digitalSignaturesSchema.optional(),
  }),
});
export type Security = z.infer<typeof securitySchema>;

export function parseSecurity(input: unknown): Security {
  return securitySchema.parse(input);
}
