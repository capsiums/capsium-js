#!/usr/bin/env node
/**
 * Serve harness for @capsium/reactor-node, used by the Capsium conformance
 * kit (via harness/conformance_reactor_adapter.rb) and handy for manual
 * checks.
 *
 * Loads one package with createReactor — fail-fast, so a package that
 * fails §6 integrity, §6a signature or §6b decryption checks exits the
 * process with a non-zero status before serving — and binds a plain
 * node:http server. Prints `listening on <url>` once bound, then serves
 * until terminated (SIGTERM/SIGINT).
 *
 * Usage (from the repo root, after `yarn build`):
 *
 *   node --conditions=bundled harness/serve.mjs <package.cap|dir> \
 *     [--port N] [--store DIR] [--decryption-key KEY.pem]
 *
 * `--conditions=bundled` resolves the workspace @capsium/* packages to
 * their built dist/ bundles: the dev-time "import" export condition
 * points at TypeScript sources, which plain Node cannot execute.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createReactor } from '@capsium/reactor-node';

const USAGE =
  'Usage: serve.mjs <package.cap|dir> [--port N] [--store DIR] [--decryption-key KEY.pem]';

function parseArgs(argv) {
  const options = { port: 0, store: undefined, decryptionKey: undefined };
  let packagePath;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => {
      const candidate = argv[index + 1];
      if (candidate === undefined || candidate.startsWith('--')) {
        throw new Error(`${arg} requires a value`);
      }
      index += 1;
      return candidate;
    };
    if (arg === '--port') {
      options.port = Number(value());
      if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
        throw new Error(`--port must be an integer between 0 and 65535`);
      }
    } else if (arg === '--store') {
      options.store = value();
    } else if (arg === '--decryption-key') {
      options.decryptionKey = value();
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (packagePath !== undefined) {
      throw new Error(`unexpected extra argument: ${arg}`);
    } else {
      packagePath = arg;
    }
  }
  if (packagePath === undefined) {
    throw new Error('missing package path (a .cap archive or directory)');
  }
  return { packagePath, ...options };
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }

  const reactorOptions = { package: args.packagePath };
  if (args.store !== undefined) {
    reactorOptions.store = args.store;
  }
  if (args.decryptionKey !== undefined) {
    reactorOptions.decryptionKeyPem = await readFile(args.decryptionKey, 'utf8');
  }

  let handler;
  try {
    handler = await createReactor(reactorOptions);
  } catch (error) {
    // A conformant rejection (tampered, bad signature, missing key, ...)
    // surfaces as a typed init error; exiting non-zero is the signal the
    // conformance adapter turns into a StartError.
    console.error(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  server.once('error', (error) => {
    console.error(`failed to start: ${error.message}`);
    process.exitCode = 1;
  });
  await new Promise((resolve) => server.listen(args.port, '127.0.0.1', resolve));

  const { port } = server.address();
  console.log(`listening on http://127.0.0.1:${port}`);

  const shutdown = () => {
    server.close(() => process.exit(0));
    // Do not linger on keep-alive connections when asked to stop.
    setTimeout(() => process.exit(0), 500).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

await main();
