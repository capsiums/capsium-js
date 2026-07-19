/**
 * Reactor introspection API response models (ARCHITECTURE.md §7).
 * Reactors build these; clients may validate them.
 */
import { z } from 'zod';

export const introspectMetadataResponseSchema = z.object({
  packages: z.array(
    z.object({
      name: z.string().min(1),
      version: z.string().min(1),
      author: z.string().optional(),
      description: z.string(),
    }),
  ),
});
export type IntrospectMetadataResponse = z.infer<typeof introspectMetadataResponseSchema>;

export const introspectRoutesResponseSchema = z.object({
  routes: z.array(
    z.object({
      package: z.string().min(1),
      routes: z.array(z.object({ method: z.string().min(1), path: z.string().min(1) })),
    }),
  ),
});
export type IntrospectRoutesResponse = z.infer<typeof introspectRoutesResponseSchema>;

export const contentHashesResponseSchema = z.object({
  contentHashes: z.array(z.object({ package: z.string().min(1), hash: z.string().min(1) })),
});
export type ContentHashesResponse = z.infer<typeof contentHashesResponseSchema>;

export const contentValidityResponseSchema = z.object({
  contentValidity: z.array(
    z.object({
      package: z.string().min(1),
      valid: z.boolean(),
      lastChecked: z.iso.datetime(),
      /** §6a: the package declares a signature (mirrors the Ruby reactor). */
      signed: z.boolean().optional(),
      /** §6b: the package was served from an encrypted .cap. */
      encrypted: z.boolean().optional(),
      /** §6a signature verification outcome; present when signed. */
      signatureValid: z.boolean().optional(),
      reason: z.string().optional(),
    }),
  ),
});
export type ContentValidityResponse = z.infer<typeof contentValidityResponseSchema>;
