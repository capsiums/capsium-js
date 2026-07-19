# @capsium/reactor-node

Framework-agnostic Node.js reactor for [Capsium](https://github.com/capsiums)
packages: serves a `.cap` archive (or an unpacked package directory) over
`node:http` or as Connect/Express middleware, per the canonical schemas in
the Capsium org architecture decisions ([`../../../ARCHITECTURE.md`](https://github.com/capsiums)):

- static resource routes with manifest MIME types and a
  `Cache-Control: public, max-age=31536000` default (route-level `headers`
  override it wholesale);
- dataset routes under `/api/v1/data/` served as JSON;
- §5a layered storage (top-first overlay, `.capsium-tombstones` deletions
  resolve 404) and §4a composite packages (`capsium://<guid>/<path>`
  dependency resources resolved from a package store; only `exported`
  resources are visible; `remap`/`responseRewrite`/`responseHeaders`
  inheritance attributes honored);
- the §7 introspection API under `/api/v1/introspect/`
  (`metadata`, `routes`, `content-hashes`, `content-validity`);
- handler routes answer `501` (not executed by this reactor);
- GET/HEAD only — anything else is `405` with an `Allow` header;
- unknown paths within the package get a JSON `404` (`{"error": "..."}`).

Init is fail-fast: the package is loaded and verified (§6 SHA-256 checksums,
§6a digital signatures, §4a dependency resolution) before the handler is
returned; problems throw typed errors (`PackageConfigError`,
`PackageIntegrityError`, `SignatureMismatchError`, `EncryptedPackageError`,
`DependencyResolutionError`, ...).

## Install

```sh
npm install @capsium/reactor-node
```

## Usage

Plain `node:http`:

```ts
import { createServer } from 'node:http';
import { createReactor } from '@capsium/reactor-node';

const handler = await createReactor({ package: './my-package.cap' });
createServer((req, res) => void handler(req, res)).listen(8864);
```

As Express/Connect middleware (the reactor owns its URL space — mount it at
the path the package should be served from; `next(err)` is called only for
unexpected internal errors):

```ts
import express from 'express';
import { createReactor } from '@capsium/reactor-node';

const app = express();
app.use('/my-package', await createReactor({ package: './my-package.cap' }));
app.listen(3000); // package served under /my-package
```

### Options

```ts
await createReactor({
  // Package directory, .cap archive path, or an already-read
  // PackageReader result (CapsiumPackage model).
  package: './my-package.cap',
  // §4a store directory for composite packages (default: CAPSIUM_STORE env).
  store: './store',
  // Cache-Control default for static resources (route headers override).
  cacheControl: 'public, max-age=31536000',
  // RSA private key PEM for §6b encrypted packages.
  decryptionKeyPem: process.env.CAPSIUM_KEY,
});
```

## CLI

Instant local serving over a plain `node:http` server (default port 8864,
`--port 0` picks an ephemeral port):

```sh
capsium-reactor-node ./my-package.cap --port 8080 --store ./store
# or from a checkout: node packages/reactor-node/dist/bin.js ./my-package.cap
```

## Development

```sh
corepack yarn install
corepack yarn workspaces foreach -A --include @capsium/reactor-node run test
```

Tests drive the handler through real `node:http` servers bound to ephemeral
ports (supertest-style); no Express dependency is used anywhere.
