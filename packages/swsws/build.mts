import { join } from 'node:path';
import { build as esbuild } from 'esbuild';


interface BuildOptions {
  logLevel: 'debug' | 'info' | 'error' | 'silent'
  packageRoot: string 
}

async function build(opts: BuildOptions) {
  return await esbuild({
    entryPoints: [
      // Web page showing a simple “drop zip here” GUI
      join(opts.packageRoot, 'index.tsx'),
      // Service worker that will unpack the site & start resolving paths
      join(opts.packageRoot, 'serviceWorker.ts'),
    ],
    entryNames: '[dir]/[name]',
    assetNames: '[dir]/[name]',
    tsconfig: join(opts.packageRoot, 'client-side-tsconfig.json'),
    format: 'iife',
    target: ['chrome120'],
    bundle: true,
    minify: false,
    treeShaking: true,
    sourcemap: false,
    platform: 'browser',
    outdir: join(opts.packageRoot, 'dist'),
    write: true,
    loader: {
      '.css': 'css',
      '.module.css': 'local-css',
    },
    logLevel: opts.logLevel,
    plugins: [],
  });
}
