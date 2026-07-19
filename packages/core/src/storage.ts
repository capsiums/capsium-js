/**
 * storage.json model (ARCHITECTURE.md §5) — dataset declarations and
 * layered storage (§5a).
 *
 * Dataset kinds (discriminated by key, open/closed via union):
 * - schema-backed file: `{source, schemaFile?, schemaType?}` (JSON/YAML/CSV/TSV).
 * - SQLite: `{databaseFile, table}`.
 *
 * Legacy-read normalization: the old gem emitted
 * `{"datasets": [{"name", "source", "format", "schema"}]}`; readers accept it
 * and normalize to `{storage: {dataSets: {<name>: ...}}}`.
 *
 * §5a layered storage: `storage.layers` (array, bottom → top) of
 * `{path, writable?, visibility?}`; each layer is a package-relative
 * directory mirroring the package tree. Overlay resolution lives in
 * `layers.ts`.
 */
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { resourceVisibilitySchema } from './manifest.js';
import { mimeTypeForPath } from './mime.js';

export const schemaFileDatasetSchema = z.object({
  source: z.string().min(1),
  schemaFile: z.string().min(1).optional(),
  schemaType: z.string().min(1).optional(),
});
export type SchemaFileDataset = z.infer<typeof schemaFileDatasetSchema>;

export const sqliteDatasetSchema = z.object({
  databaseFile: z.string().min(1),
  table: z.string().min(1),
});
export type SqliteDataset = z.infer<typeof sqliteDatasetSchema>;

export const datasetSchema = z.union([schemaFileDatasetSchema, sqliteDatasetSchema]);
export type Dataset = z.infer<typeof datasetSchema>;

/** One storage layer (§5a). Layers stack bottom → top; default read-only, exported. */
export const storageLayerSchema = z.object({
  /** Package-relative directory mirroring the package tree (e.g. `base`). */
  path: z.string().min(1),
  writable: z.boolean().optional(),
  visibility: resourceVisibilitySchema.optional(),
});
export type StorageLayer = z.infer<typeof storageLayerSchema>;

export const storageSchema = z.object({
  storage: z.strictObject({
    dataSets: z.record(z.string(), datasetSchema).default({}),
    /** Layered storage (overlay FS), bottom → top. */
    layers: z.array(storageLayerSchema).optional(),
  }),
});
export type Storage = z.infer<typeof storageSchema>;

/** Layer writability (default false — layers are read-only). */
export function layerWritable(layer: StorageLayer): boolean {
  return layer.writable ?? false;
}

/** Layer visibility (default `exported`). */
export function layerVisibility(layer: StorageLayer): 'exported' | 'private' {
  return layer.visibility ?? 'exported';
}

export function isSchemaFileDataset(dataset: Dataset): dataset is SchemaFileDataset {
  return 'source' in dataset;
}

export function isSqliteDataset(dataset: Dataset): dataset is SqliteDataset {
  return 'databaseFile' in dataset;
}

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/**
 * Body and Content-Type for a served schema-file dataset source (§5):
 * YAML sources are parsed and re-serialized as JSON (as the Ruby reactor
 * does); every other source serves verbatim with its detected type.
 */
export function datasetSourceResponse(
  sourcePath: string,
  bytes: Uint8Array,
): { readonly contentType: string; readonly body: Uint8Array } {
  if (/\.ya?ml$/i.test(sourcePath)) {
    const parsed: unknown = parseYaml(textDecoder.decode(bytes));
    return {
      contentType: 'application/json',
      body: textEncoder.encode(JSON.stringify(parsed)),
    };
  }
  return {
    contentType: mimeTypeForPath(sourcePath) ?? 'application/json',
    body: bytes,
  };
}

const legacyDatasetEntrySchema = z.looseObject({
  name: z.string().min(1),
});

const legacyStorageSchema = z.object({
  datasets: z.array(legacyDatasetEntrySchema),
});

/**
 * Map one legacy `{name, source, format, schema, databaseFile?, table?}`
 * entry to its canonical dataset form. `schema` maps to `schemaFile` and
 * `format` maps to `schemaType` when a schema file is present.
 */
function normalizeLegacyDataset(entry: z.infer<typeof legacyDatasetEntrySchema>): Dataset {
  const { name: _name, source, format, schema, databaseFile, table, ...rest } = entry as {
    name: string;
    source?: string;
    format?: string;
    schema?: string;
    databaseFile?: string;
    table?: string;
  } & Record<string, unknown>;
  void rest;
  if (databaseFile !== undefined) {
    return sqliteDatasetSchema.parse({ databaseFile, table });
  }
  return schemaFileDatasetSchema.parse({
    source,
    ...(schema !== undefined ? { schemaFile: schema, schemaType: format ?? 'json-schema' } : {}),
  });
}

/** Parse storage.json, accepting the legacy gem `{datasets: [...]}` form. */
export function parseStorage(input: unknown): Storage {
  const canonical = storageSchema.safeParse(input);
  if (canonical.success) {
    return canonical.data;
  }
  const legacy = legacyStorageSchema.safeParse(input);
  if (legacy.success) {
    const dataSets = Object.fromEntries(
      legacy.data.datasets.map((entry) => [entry.name, normalizeLegacyDataset(entry)]),
    );
    return { storage: { dataSets } };
  }
  throw canonical.error;
}
