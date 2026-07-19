/**
 * Shared location of the bundled worker the miniflare tests load. The
 * global setup writes it; the tests read it (node_modules/.cache is always
 * gitignored).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const WORKER_BUNDLE_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'node_modules',
  '.cache',
  'reactor-cloudflare-tests',
);

export const WORKER_BUNDLE = join(WORKER_BUNDLE_DIR, 'worker.js');
