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
> [release workflow](.github/workflows/publish.yml) (see
> [Releasing](#releasing)); inside the workspace they resolve to `src/`
> directly (the published `exports` map to `dist/` via `publishConfig`).

## Packages

| Package | Purpose |
| --- | --- |
| [`@capsium/core`](packages/core) | Domain model layer: zod v4 schemas + inferred types for metadata, manifest, routes, storage (incl. §5a layers), security, encryption envelope, authentication (§2–6, §4a/4b); legacy-read normalization (old Ruby gem forms); manifest/routes auto-generation (§3–4); checksum compute/verify against an injected `HashProvider`; §6a signed-payload construction + signature verify against an injected `SignatureProvider`; minimal semver for dependency resolution; composite-package helpers (`capsium://` references, exported-visibility enforcement); reactor route resolution (`RouteResolver` + §7 introspection paths); the 05x-testing YAML DSL runner (`runPackageTests`); JSON Schema (draft 2020-12) generation into `schemas/`. Isomorphic — no Node or browser APIs. |
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
[`.github/workflows/publish.yml`](.github/workflows/publish.yml): push a
`v*` tag and the workflow installs, runs the lint/typecheck/test/build
gates, then publishes every public package (`@capsium/core`,
`@capsium/packager`, `@capsium/swsws`, `@capsium/reactor-node`) in
topological order with `yarn npm publish` (which rewrites `workspace:^`
ranges to real versions and applies each package's `publishConfig` —
`access: public` and the `dist/`-based `exports` map).

The one manual prerequisite (cannot be automated from this repo):

1. Create the `@capsium` npm organization (npmjs.com → New Organization).
2. Create a granular access token with publish rights on `@capsium` and
   add it to this repository's secrets as `NPM_TOKEN` (Settings → Secrets
   and variables → Actions). The workflow exposes it as
   `NODE_AUTH_TOKEN`/`YARN_NPM_AUTH_TOKEN`.

Release checklist: bump `version` in all four package.json files (kept in
lockstep), commit, tag `v<version>`, push the tag.
