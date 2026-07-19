import { defineConfig } from 'tsup';

export default defineConfig([
  {
    // Library entry (reactor building blocks); deps stay external.
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    platform: 'browser',
    target: 'es2022',
    dts: true,
    sourcemap: true,
    clean: true,
    outDir: 'dist',
  },
  {
    // The service worker must be self-contained: bundle the runtime deps.
    entry: { sw: 'src/sw.ts' },
    format: ['iife'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    sourcemap: true,
    clean: false,
    minify: false,
    noExternal: ['@capsium/core', 'fflate'],
    // Emit dist/sw.js (the name the demo page registers), not sw.global.js.
    outExtension: () => ({ js: '.js' }),
    outDir: 'dist',
  },
]);
