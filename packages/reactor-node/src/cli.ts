/**
 * Library side of the `capsium-reactor-node` bin: argument parsing and the
 * instant local server (a plain node:http server around the reactor
 * handler). Kept separate from the bin shim so tests can drive it in
 * process.
 */
import { createServer, type Server } from 'node:http';
import { CapsiumError } from '@capsium/core';
import { createReactor } from './reactor.js';

/** Matches the Ruby reactor's default port. */
export const DEFAULT_PORT = 8864;

export const CLI_USAGE =
  'Usage: capsium-reactor-node <package.cap|dir> [--port N] [--store DIR] [--cache-control VALUE]';

/** Malformed command line (exit code 2 in the bin). */
export class CliUsageError extends CapsiumError {}

export interface CliOptions {
  readonly packagePath: string;
  readonly port: number;
  readonly store?: string;
  readonly cacheControl?: string;
}

function optionValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new CliUsageError(`${flag} requires a value`);
  }
  return value;
}

/** Parse bin arguments (without `--help`, handled by the bin shim). */
export function parseCliArgs(argv: readonly string[]): CliOptions {
  let packagePath: string | undefined;
  let port = DEFAULT_PORT;
  let store: string | undefined;
  let cacheControl: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (arg === '--port') {
      const value = optionValue(argv, index, '--port');
      port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new CliUsageError(`--port must be an integer between 0 and 65535, got: ${value}`);
      }
      index += 1;
    } else if (arg === '--store') {
      store = optionValue(argv, index, '--store');
      index += 1;
    } else if (arg === '--cache-control') {
      cacheControl = optionValue(argv, index, '--cache-control');
      index += 1;
    } else if (arg.startsWith('--')) {
      throw new CliUsageError(`unknown option: ${arg}`);
    } else if (packagePath !== undefined) {
      throw new CliUsageError(`unexpected extra argument: ${arg}`);
    } else {
      packagePath = arg;
    }
  }

  if (packagePath === undefined) {
    throw new CliUsageError('missing package path (a .cap archive or directory)');
  }
  return {
    packagePath,
    port,
    ...(store !== undefined ? { store } : {}),
    ...(cacheControl !== undefined ? { cacheControl } : {}),
  };
}

export interface RunningServer {
  readonly server: Server;
  readonly port: number;
  readonly url: string;
}

/** Create the reactor handler and bind a node:http server (port 0 = ephemeral). */
export async function startServer(options: CliOptions): Promise<RunningServer> {
  const handler = await createReactor({
    package: options.packagePath,
    ...(options.store !== undefined ? { store: options.store } : {}),
    ...(options.cacheControl !== undefined ? { cacheControl: options.cacheControl } : {}),
  });
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, () => {
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address !== null ? address.port : options.port;
  return { server, port, url: `http://localhost:${port}` };
}
