/**
 * `capsium-reactor-node <cap|dir> [--port 0] [--store DIR]` — instant local
 * serving of a Capsium package over a plain node:http server. (The shebang
 * is added by the tsup banner so it is not duplicated in dist/bin.js.)
 */
import { parseCliArgs, startServer, CLI_USAGE } from './cli.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(CLI_USAGE);
    return;
  }

  let options;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(CLI_USAGE);
    process.exitCode = 2;
    return;
  }

  try {
    const { url } = await startServer(options);
    console.log(`capsium-reactor-node serving ${options.packagePath}`);
    console.log(`listening on ${url}`);
  } catch (error) {
    console.error(`failed to start: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

void main();
