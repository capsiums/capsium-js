/**
 * metadata.json model (ARCHITECTURE.md §2) — hand-authored package metadata.
 *
 * Canonical form plus legacy-read normalization: the old Ruby gem emitted
 * `dependencies` as an array of `{name, version}`; readers accept it and
 * normalize to the object form (guid -> semver range). Writers emit only the
 * canonical object form.
 */
import { z } from 'zod';

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// UUID in the 8-4-4-4-12 hex form the spec and the Ruby gem accept
// (metadata_config.rb UUID_PATTERN); no RFC 9562 version/variant
// enforcement — z.uuid() would reject spec-valid hand-assigned uuids.
// The case class is written out (not /i) so generated JSON Schemas agree.
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Official semver regex from semver.org (no partial versions).
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const repositorySchema = z.object({
  type: z.string().min(1),
  url: z.url(),
});
export type Repository = z.infer<typeof repositorySchema>;

export const metadataSchema = z.object({
  name: z.string().regex(KEBAB_CASE, 'name must be kebab-case'),
  version: z.string().regex(SEMVER, 'version must be valid semver'),
  description: z.string().min(1),
  // guid/uuid are optional on read (the Ruby model treats them the same
  // way — the legacy corpus form omits them); format-validated when present.
  guid: z.url().optional(),
  uuid: z.string().regex(UUID, 'uuid must be a valid UUID').optional(),
  author: z.string().min(1).optional(),
  license: z.string().min(1).optional(),
  repository: repositorySchema.optional(),
  /** Object form: package guid -> semver range. */
  dependencies: z.record(z.string(), z.string()).optional(),
  readOnly: z.boolean().optional(),
  /** Claimed optional modules (kebab-case identifiers, e.g. "signatures"). */
  modules: z.array(z.string().regex(KEBAB_CASE, 'module ids must be kebab-case')).optional(),
});
export type Metadata = z.infer<typeof metadataSchema>;

const legacyDependencySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
});

/**
 * Parse metadata.json, accepting the legacy gem form for `dependencies`
 * (array of `{name, version}`) and normalizing it to the canonical object.
 */
export function parseMetadata(input: unknown): Metadata {
  if (typeof input === 'object' && input !== null && 'dependencies' in input) {
    const { dependencies } = input as { dependencies: unknown };
    if (Array.isArray(dependencies)) {
      const entries = z.array(legacyDependencySchema).parse(dependencies);
      const normalized = Object.fromEntries(entries.map((e) => [e.name, e.version]));
      return metadataSchema.parse({ ...input, dependencies: normalized });
    }
  }
  return metadataSchema.parse(input);
}
