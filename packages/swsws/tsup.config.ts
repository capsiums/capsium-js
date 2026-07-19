import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { sw: 'src/sw.ts' },
  format: ['iife'],
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: true,
  minify: false,
  // The service worker must be self-contained: bundle the runtime deps.
  noExternal: ['@capsium/core', 'fflate'],
  // Emit dist/sw.js (the name the demo page registers), not sw.global.js.
  outExtension: () => ({ js: '.js' }),
  outDir: 'dist',
});
