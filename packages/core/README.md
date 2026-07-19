# @capsium/core

Domain model layer of the Capsium TypeScript runtime: zod v4 schemas +
inferred types for the canonical package configs (ARCHITECTURE.md §2–6,
§4a/§4b), legacy-read normalization, manifest/routes auto-generation,
checksum/signature logic, composite-package helpers, reactor route
resolution, the §7 introspection response models, the 05x-testing YAML DSL
runner, and JSON Schema generation. Isomorphic — no Node or browser APIs;
platform crypto is injected (`HashProvider`/`SignatureProvider`).

## Install

```sh
npm install @capsium/core
```

## Usage

Parse and validate package configs (legacy forms normalize on read):

```ts
import { parseMetadata, parseManifest, parseRoutes, parseStorage } from '@capsium/core';

const metadata = parseMetadata(JSON.parse(metadataJson));
const routes = parseRoutes(JSON.parse(routesJson)); // accepts the legacy object form too
```

Whole-package parsing with §3–4 auto-generation:

```ts
import { parsePackage } from '@capsium/core';

// files: ReadonlyMap<string, Uint8Array> — package-relative POSIX paths -> bytes
const pkg = parsePackage(files); // manifest/routes generated when absent
```

Integrity (§6) and signatures (§6a) against injected crypto:

```ts
import { buildSecurity, verifyIntegrity, assertPackageSignature } from '@capsium/core';

const security = await buildSecurity(files, hashProvider);
const report = await verifyIntegrity(files, security, hashProvider); // typed issue list
await assertPackageSignature(files, security, signatureProvider); // throws on mismatch
```

Route resolution and §7 introspection paths (shared by the reactors):

```ts
import { RouteResolver, matchIntrospection } from '@capsium/core';

const resolution = new RouteResolver(pkg.routes).resolve('/about', 'GET');
const endpoint = matchIntrospection('/api/v1/introspect/metadata'); // 'metadata'
```

JSON Schemas (draft 2020-12) for the canonical configs are generated from
these models — emitted under [`schemas/`](schemas) with `$id`s
`https://www.capsium.org/schemas/<name>.schema.json` (`metadata`,
`manifest`, `routes`, `storage`, `security`, `authentication`):

```ts
import { buildJsonSchemas } from '@capsium/core';

const schemas = buildJsonSchemas(); // regenerate: yarn workspace @capsium/core build:schemas
```

## Development

```sh
corepack yarn workspaces foreach -A --include @capsium/core run test
```
