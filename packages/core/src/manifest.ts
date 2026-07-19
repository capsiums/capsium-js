/**
 * manifest.json model (ARCHITECTURE.md §3) — package resource inventory.
 *
 * Canonical form: `{resources: {<package-relative path>: {type, visibility?, version?}}}`.
 * Legacy-read normalization: the old gem emitted `{content: [{file, mime}]}`;
 * readers accept it and normalize. Writers emit only the canonical form.
 */
import { z } from 'zod';

export const resourceVisibilitySchema = z.enum(['exported', 'private']);
export type ResourceVisibility = z.infer<typeof resourceVisibilitySchema>;

export const manifestResourceSchema = z.object({
  /** MIME type of the resource (required; RFC 9239: javascript is text/javascript). */
  type: z.string().min(1),
  visibility: resourceVisibilitySchema.optional(),
  version: z.string().min(1).optional(),
});
export type ManifestResource = z.infer<typeof manifestResourceSchema>;

export const manifestSchema = z.object({
  resources: z.record(z.string(), manifestResourceSchema),
});
export type Manifest = z.infer<typeof manifestSchema>;

const legacyManifestSchema = z.object({
  content: z.array(
    z.object({
      file: z.string().min(1),
      mime: z.string().min(1),
    }),
  ),
});

/** Visibility of a resource; defaults to `exported` when unspecified. */
export function resourceVisibility(resource: ManifestResource): ResourceVisibility {
  return resource.visibility ?? 'exported';
}

/** Parse manifest.json, accepting the legacy `{content: [{file, mime}]}` form. */
export function parseManifest(input: unknown): Manifest {
  const canonical = manifestSchema.safeParse(input);
  if (canonical.success) {
    return canonical.data;
  }
  const legacy = legacyManifestSchema.safeParse(input);
  if (legacy.success) {
    const resources = Object.fromEntries(
      legacy.data.content.map((entry) => [entry.file, { type: entry.mime }]),
    );
    return { resources };
  }
  throw canonical.error;
}
