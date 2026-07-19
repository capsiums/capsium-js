# @capsium/reactor-cloudflare

Cloudflare Workers reactor for [Capsium](https://github.com/capsiums) `.cap`
packages. Install a package over HTTP and serve it per `routes.json` — with
SHA-256 integrity verification (§6), RSA-SHA256 signature verification when
declared (§6a), §5a layered storage, and the §7 introspection API — all from a
single module-format Worker.

## Quickstart (wrangler)

```sh
npm install @capsium/reactor-cloudflare
```

`wrangler.toml`:

```toml
name = "capsium-reactor"
main = "node_modules/@capsium/reactor-cloudflare/dist/worker.js"
compatibility_date = "2025-09-01"

[vars]
INSTALL_TOKEN = "change-me"          # required for POST /__capsium/install
# PACKAGE_URL = "https://example.com/site.cap"  # optional: install at startup
# PATH_PREFIX = "/docs"              # optional: mount under a path prefix
```

```sh
npx wrangler deploy
```

Install a package:

```sh
curl -X POST \
  -H "Authorization: Bearer change-me" \
  -H "Content-Type: application/vnd.capsium.package" \
  --data-binary @my-package.cap \
  https://capsium-reactor.<account>.workers.dev/__capsium/install
# => {"ok":true,"name":"my-package","version":"1.0.0","contentHash":"…"}
```

Then browse the package routes: `https://capsium-reactor.<account>.workers.dev/`.

## HTTP API

- `POST /__capsium/install` — install a `.cap` body. Requires
  `Authorization: Bearer <INSTALL_TOKEN>` when the variable is set (missing/
  malformed header → 401, wrong token → 403). **When `INSTALL_TOKEN` is not
  set the endpoint is open — development mode only; always set a token before
  deploying.** Verification failures are typed JSON problem bodies
  (`{"error": "…"}`): 400 malformed archive/package, 422 checksum or
  signature mismatch. Reinstalling replaces the previous package.
- Package routes per `routes.json` — dual HTML routes, `/` index,
  `/api/v1/data/<id>` datasets (JSON), §5a layered storage (tombstoned paths
  404). `Cache-Control: public, max-age=31536000` by default; a route's own
  `headers` override that wholesale. GET/HEAD only (405 + `Allow` otherwise),
  handler routes 501, JSON 404s.
- §7 introspection (GET/HEAD): `/api/v1/introspect/metadata`,
  `/api/v1/introspect/routes`, `/api/v1/introspect/content-hashes`,
  `/api/v1/introspect/content-validity`.

All paths are relative to the mount prefix when `PATH_PREFIX` is set (e.g.
`/docs/__capsium/install`, `/docs/api/v1/introspect/metadata`); requests
outside the prefix get a JSON 404.

## Startup install

When `PACKAGE_URL` is set and no package is installed, the first request
fetches that `.cap` and installs it before being served — convenient for
read-only deployments where the package is published next to the site.
Failures are logged and the worker keeps serving 404s until a package
installs successfully (retry on the next cold start, or via the install
endpoint).

## Persistence caveat (Cache API)

Installed packages are persisted **unzipped in the Cache API**
(`caches.default`, one synthetic request key per file plus a small manifest
entry). The Cache API is **per-colo and best-effort**: entries can be
evicted at any time and are not replicated. The reactor re-verifies the
stored package on every cold start and drops a damaged (partially evicted)
install, but an eviction still means the package must be re-installed
(`POST /__capsium/install`, or automatically when `PACKAGE_URL` is set).
For durable storage, backing the store with **R2 or Workers KV is a planned
follow-up** (the `CachePackageStore` is the single seam to replace).

## Programmatic usage

The default worker entry is just `export default createWorker()`. For custom
wiring (e.g. combining with your own routes), use the factory:

```ts
import { createWorker } from '@capsium/reactor-cloudflare';

const capsium = createWorker({ installToken: 'change-me' });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname.startsWith('/admin')) {
      return new Response('your own route');
    }
    return capsium.fetch(request, env, ctx);
  },
};
```

Options: `installToken`, `packageUrl`, `pathPrefix`, `cacheControl`, `cache`
(each overrides its env counterpart where applicable).

## Out of scope (deferrals)

- §4a composite packages: the install endpoint takes a single `.cap`;
  routes referencing `capsium://` dependencies answer 404.
- §4b authentication (basic/OAuth2), JS handler execution (501), SQLite
  datasets (501).
- Durable persistence via R2/KV (see the caveat above).

## Development

Yarn workspace package in the capsium-js monorepo. Tests run the bundled
worker under miniflare (real workerd):

```sh
corepack yarn install
corepack yarn workspace @capsium/reactor-cloudflare test
```

License: MIT.
