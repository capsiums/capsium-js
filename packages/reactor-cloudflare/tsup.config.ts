import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library entry (createWorker factory); deps stay external.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
  },
  {
    // The worker entry must be self-contained: bundle the runtime deps so
    // wrangler can deploy dist/worker.js as-is.
    entry: { worker: 'src/worker.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    noExternal: [/.*/],
    outDir: 'dist',
  },
]);
