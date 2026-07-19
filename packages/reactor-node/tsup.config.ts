import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'es2022',
    outDir: 'dist',
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    dts: false,
    sourcemap: true,
    clean: false,
    target: 'es2022',
    outDir: 'dist',
    // Self-contained CLI: bundle every dependency (dev-time package exports
    // point at TypeScript sources, which plain Node cannot execute). The
    // banner carries the shebang (src/bin.ts omits it so it is not
    // duplicated) and a createRequire shim for CJS deps (yaml) bundled
    // into the ESM output.
    noExternal: [/.*/],
    banner: {
      js: [
        '#!/usr/bin/env node',
        "import { createRequire as __binCreateRequire } from 'node:module';",
        'const require = __binCreateRequire(import.meta.url);',
      ].join('\n'),
    },
  },
]);
