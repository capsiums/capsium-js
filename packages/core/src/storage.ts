/**
 * storage.json model (ARCHITECTURE.md §5) — dataset declarations.
 *
 * Dataset kinds (discriminated by key, open/closed via union):
 * - schema-backed file: `{source, schemaFile?, schemaType?}` (JSON/YAML/CSV/TSV).
 * - SQLite: `{databaseFile, table}`.
 *
 * Legacy-read normalization: the old gem emitted
 * `{"datasets": [{"name", "source", "format", "schema"}]}`; readers accept it
 * and normalize to `{storage: {dataSets: {<name>: ...}}}`. Layered storage
 * (`layers`) is parsed if present but has no behavior yet.
 */
import { z } from 'zod';

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

export const storageSchema = z.object({
  storage: z.object({
    dataSets: z.record(z.string(), datasetSchema),
    /** Layered storage (overlay FS): parsed, no behavior yet. */
    layers: z.array(z.unknown()).optional(),
  }),
});
export type Storage = z.infer<typeof storageSchema>;

export function isSchemaFileDataset(dataset: Dataset): dataset is SchemaFileDataset {
  return 'source' in dataset;
}

export function isSqliteDataset(dataset: Dataset): dataset is SqliteDataset {
  return 'databaseFile' in dataset;
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
