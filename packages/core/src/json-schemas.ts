/**
 * JSON Schema (draft 2020-12) generation from the canonical zod models
 * (ARCHITECTURE.md §2-6, §4b) via zod's built-in `z.toJSONSchema`.
 *
 * One document per package config file: metadata, manifest, routes,
 * storage, security, authentication. Documents are self-contained (any
 * `$ref`s point at local `$defs`), carry `$id`s under
 * `https://www.capsium.org/schemas/`, and describe the CANONICAL input
 * forms (`io: 'input'` — fields with defaults are not required). The
 * legacy-read normalizations (object-keyed routes, gem-era datasets and
 * dependencies arrays) are reader conveniences and intentionally not part
 * of the schemas.
 *
 * Emitted to `schemas/` by `scripts/generate-schemas.ts` (the package
 * `build:schemas` script) and committed; the json-schemas test fails on
 * drift.
 */
import { z } from 'zod';
import { authenticationSchema } from './authentication.js';
import { manifestSchema } from './manifest.js';
import { metadataSchema } from './metadata.js';
import { routesSchema } from './routes.js';
import { securitySchema } from './security.js';
import { storageSchema } from './storage.js';

/** Canonical `$id` prefix for the emitted schema documents. */
export const JSON_SCHEMA_ID_BASE = 'https://www.capsium.org/schemas/';

/** Draft 2020-12 dialect identifier (zod's toJSONSchema default target). */
export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** One named config-file schema document. */
export interface CapsiumJsonSchema {
  /** Config name: metadata | manifest | routes | storage | security | authentication. */
  readonly name: string;
  /** Emitted file name: `<name>.schema.json`. */
  readonly fileName: string;
  /** Canonical `$id`: `https://www.capsium.org/schemas/<name>.schema.json`. */
  readonly id: string;
  /** The complete draft 2020-12 document (`$id` + zod output). */
  readonly schema: Readonly<Record<string, unknown>>;
}

/** The canonical zod model per config file, in emission order. */
const CANONICAL_MODELS: ReadonlyArray<readonly [string, z.ZodType]> = [
  ['metadata', metadataSchema],
  ['manifest', manifestSchema],
  ['routes', routesSchema],
  ['storage', storageSchema],
  ['security', securitySchema],
  ['authentication', authenticationSchema],
];

/** Build the draft 2020-12 document for one canonical model. */
export function buildJsonSchema(name: string, model: z.ZodType): CapsiumJsonSchema {
  const fileName = `${name}.schema.json`;
  const id = `${JSON_SCHEMA_ID_BASE}${fileName}`;
  const document = z.toJSONSchema(model, { io: 'input' }) as Record<string, unknown>;
  return { name, fileName, id, schema: { $id: id, ...document } };
}

/** Build all six canonical config schemas, in emission order. */
export function buildJsonSchemas(): readonly CapsiumJsonSchema[] {
  return CANONICAL_MODELS.map(([name, model]) => buildJsonSchema(name, model));
}
