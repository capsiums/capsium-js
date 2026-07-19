/**
 * Default Cloudflare Workers entry: the Capsium reactor configured from
 * environment bindings ([vars] in wrangler.toml):
 *
 * - INSTALL_TOKEN — bearer token required for POST /__capsium/install.
 * - PACKAGE_URL   — .cap fetched+installed at startup when nothing is installed.
 * - PATH_PREFIX   — mount path prefix (e.g. /docs); default /.
 *
 * Deploy with `main = "node_modules/@capsium/reactor-cloudflare/dist/worker.js"`
 * in wrangler.toml (see the package README for a full example). For custom
 * wiring use `createWorker(options)` from the library entry instead.
 */
import { createWorker } from './create-worker.js';

export default createWorker();
