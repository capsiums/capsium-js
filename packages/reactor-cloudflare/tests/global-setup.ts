/**
 * Vitest global setup: bundle the default worker entry (all dependencies
 * inlined, exactly what wrangler would deploy) so miniflare loads a single
 * self-contained ES module.
 */
import { mkdir, rm } from 'node:fs/promises';
import { build } from 'tsup';
import { WORKER_BUNDLE_DIR } from './bundle-path.js';

export async function setup(): Promise<() => Promise<void>> {
  await mkdir(WORKER_BUNDLE_DIR, { recursive: true });
  await build({
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    dts: false,
    sourcemap: false,
    clean: true,
    noExternal: [/.*/],
    outDir: WORKER_BUNDLE_DIR,
    silent: true,
    config: false,
  });
  return async () => {
    await rm(WORKER_BUNDLE_DIR, { recursive: true, force: true });
  };
}
