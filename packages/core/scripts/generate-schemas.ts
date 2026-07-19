/**
 * Emit `packages/core/schemas/<name>.schema.json` from the canonical zod
 * models. Runs against the BUILT package (dist/) because Node cannot
 * resolve the sources' `.js` specifiers directly — the package `build`
 * script runs this after tsup, so a plain `yarn build` refreshes the
 * committed documents. Standalone: `yarn workspace @capsium/core
 * build:schemas` (requires a prior `tsup` run). Node >= 22.18 (native
 * type stripping).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildJsonSchemas } from '../dist/index.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
await mkdir(outDir, { recursive: true });
for (const { fileName, schema } of buildJsonSchemas()) {
  await writeFile(join(outDir, fileName), `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`schemas/${fileName}`);
}
