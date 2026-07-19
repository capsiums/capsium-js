# capsium-js

TypeScript runtime for the [Capsium](https://github.com/capsiums) project —
the monorepo implementing the canonical Capsium schemas (see
[`../ARCHITECTURE.md`](https://github.com/capsiums)) in TypeScript.

Capsium packages (`.cap` files) are ZIP archives containing a served
`content/` directory, hand-authored `metadata.json`, generated
`manifest.json`/`routes.json`/`security.json`, and optional datasets under
`data/` served at `/api/v1/data/<id>`.

> **Status: 0.2.0 — publish-ready.** All packages in this repo are versioned
> together and published to npm under the `@capsium` org by the
> [release workflow](.github/workflows/release.yml) (see
> [Releasing](#releasing)); inside the workspace they resolve to `src/`
> directly (the published `exports` map to `dist/` via `publishConfig`).

## Conformance

`@capsium/reactor-node` is continuously verified against the
[Capsium conformance kit](https://github.com/capsiums/capsium-conformance)
by the [conformance workflow](.github/workflows/conformance.yml), which
claims these conformance classes:

[![Capsium Core Reactor](https://img.shields.io/badge/Capsium_Core_Reactor-conformant-0F6B83)](https://github.com/capsiums/capsium-js/actions/workflows/conformance.yml)
[![Capsium signatures](https://img.shields.io/badge/Capsium_signatures-conformant-0F6B83)](https://github.com/capsiums/capsium-js/actions/workflows/conformance.yml)
[![Capsium encryption](https://img.shields.io/badge/Capsium_encryption-conformant-0F6B83)](https://github.com/capsiums/capsium-js/actions/workflows/conformance.yml)
[![Capsium layered--storage](https://img.shields.io/badge/Capsium_layered--storage-conformant-0F6B83)](https://github.com/capsiums/capsium-js/actions/workflows/conformance.yml)
[![Capsium composite](https://img.shields.io/badge/Capsium_composite-conformant-0F6B83)](https://github.com/capsiums/capsium-js/actions/workflows/conformance.yml)

Not claimed: `authentication` (§4b is implemented in `@capsium/swsws`, not
in the Node reactor) and `handler-routes` (the Node reactor answers handler
routes with `501`, as the kit requires of reactors not claiming the class).

To run the kit locally, check out the kit next to this repo, then:

```console
$ corepack yarn install && corepack yarn build   # the harness serves dist/
$ cd ../capsium-conformance && bundle install
$ CONFORMANCE_ADAPTER=$PWD/../capsium-js/harness/conformance_reactor_adapter.rb \
  CONFORMANCE_CLASSES=core-reactor,signatures,encryption,layered-storage,composite \
  bundle exec rspec
```

The adapter (`harness/conformance_reactor_adapter.rb`) spawns one
`node --conditions=bundled harness/serve.mjs` process per fixture; the
`bundled` export condition resolves the workspace packages to their built
`dist/` bundles (the default condition points at the TypeScript sources,
which plain Node cannot execute).

## Packages

| Package | Purpose |
| --- | --- |
| [`@capsium/core`](packages/core) | Domain model layer: zod v4 schemas + inferred types for metadata, manifest, routes, storage (incl. §5a layers), security, encryption envelope, authentication (§2–6, §4a/4b); legacy-read normalization (old Ruby gem forms); manifest/routes auto-generation (§3–4); checksum compute/verify against an injected `HashProvider`; §6a signed-payload construction + signature verify against an injected `SignatureProvider`; minimal semver for dependency resolution; composite-package helpers (`<guid>/<path>` dependency references, exported-visibility enforcement); reactor route resolution (`RouteResolver` + §7 introspection paths); the 05x-testing YAML DSL runner (`runPackageTests`); JSON Schema (draft 2020-12) generation into `schemas/`. Isomorphic — no Node or browser APIs. |
| [`@capsium/packager`](packages/packager) | Node-side `.cap` tooling: read a package directory or `.cap` into a validated model, generate missing manifest/routes, write SHA-256 `security.json`, write/extract `.cap` archives (fflate), verify integrity with a typed issue list; RSA-SHA256 signing/verification (`PackageSigner`, §6a — openssl- and Ruby-gem-compatible, verified on read); §6b encryption (`PackageCipher`: AES-256-GCM inner zip + RSA-OAEP-SHA256-wrapped DEK, transparent decryption on read with a key); `StoreDirectory` composite dependency resolution (`CAPSIUM_STORE` layout). Small DI classes throughout (`PackageReader`, `PackageWriter`, `PackageExtractor`, `IntegrityVerifier`, `CapArchive`, `NodeHashProvider`, `NodeSignatureProvider`). |
| [`@capsium/swsws`](packages/swsws) | Browser service-worker reactor: accepts a `.cap` from the page, verifies SHA-256 checksums and §6a signatures via WebCrypto, persists it in the Cache API, serves requests per `routes.json` (incl. §5a layered storage with tombstones, §4a composite dependency resources and route inheritance, §4a JS handler routes as ES modules, §4b basicAuth/OAuth2-PKCE authentication), and answers the §7 introspection endpoints. Ships a demo `index.html`; the service worker is built as a self-contained IIFE (`dist/sw.js`), the reactor building blocks as an ESM library (`dist/index.js`). |
| [`@capsium/reactor-node`](packages/reactor-node) | Framework-agnostic Node.js reactor: `createReactor()` returns a Connect/Express-compatible handler (works with plain `node:http`) serving a package directory, `.cap` archive or `PackageReader` model with fail-fast init verification (§6 checksums, §6a signatures, §6b decryption, §4a store resolution), §5a layered storage, §4a composite serving, dataset routes as JSON and the §7 introspection API; handler routes answer 501. Includes the `capsium-reactor-node` CLI for instant local serving. |

## Layout

```
packages/
  core/          @capsium/core         — domain models (single source of truth)
  packager/      @capsium/packager     — Node .cap IO
  swsws/         @capsium/swsws        — service-worker reactor
  reactor-node/  @capsium/reactor-node — Node reactor + CLI
harness/         conformance kit adapter + Node serve harness (see Conformance)
```

Design: model-driven (zod schemas are the single source of truth; types are
inferred), MECE (core = domain, packager = Node IO, swsws = browser reactor),
open/closed (route and dataset kinds are discriminated unions you can extend),
ESM everywhere, strict TypeScript.

## Commands

All commands run across workspaces from the repo root (Yarn 4, via corepack):

```sh
corepack yarn install      # install dependencies
corepack yarn build        # tsup builds (ESM + d.ts; IIFE for the swsws
                           # service worker) + JSON Schema emission (core)
corepack yarn test         # vitest
corepack yarn lint         # eslint 9 flat config + typescript-eslint
corepack yarn typecheck    # tsc --noEmit per package
```

Node >= 22 is required; CI runs the same steps on Node 22 and 24.

## Releasing

Packages publish to npm under the `@capsium` org via
[`.github/workflows/release.yml`](.github/workflows/release.yml): push a
`v*` tag and the workflow installs, runs the lint/typecheck/test/build
gates, then publishes every public package (`@capsium/core`,
`@capsium/packager`, `@capsium/swsws`, `@capsium/reactor-node`,
`@capsium/reactor-cloudflare`) in topological order — `yarn pack` rewrites
`workspace:^` ranges to real versions and applies each package's
`publishConfig`, and the npm CLI publishes the tarballs.

Publishing uses **npm trusted publishing (OIDC)** — no long-lived tokens.
One-time setup (cannot be automated from this repo):

1. Create the `@capsium` npm organization (done).
2. Manually publish each package **once** (trusted publishing can only be
   configured on existing packages):

   ```bash
   npm login
   for pkg in core packager swsws reactor-node reactor-cloudflare; do
     (cd "packages/${pkg}" \
       && yarn pack --out package.tgz \
       && npm publish package.tgz --access public \
       && rm package.tgz)
   done
   ```

3. On npmjs.com, for **each** package: Settings → Trusted publishing →
   GitHub Actions → org `capsiums`, repo `capsium-js`, workflow filename
   `release.yml`, allowed action `npm publish`.

Release checklist: bump `version` in all five package.json files (kept in
lockstep), commit, tag `v<version>`, push the tag.
