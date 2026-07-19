# swsws — service worker static website server

The browser Capsium reactor (`@capsium/swsws`): a dependency-light, hand-rolled
service worker that serves `.cap` packages straight from the zip.

> **Status: 0.2.0 — private/unpublished** (workspace-only package).

- Accepts a `.cap` blob from the page via `postMessage`, verifies SHA-256
  checksums against `security.json` (WebCrypto) and rejects tampered packages.
- Persists the verified blob in the Cache API and serves requests per
  `routes.json` (auto-generated routes included), unpacking entries with fflate.
- Answers the reactor introspection API under `/api/v1/introspect/`
  (`metadata`, `routes`, `content-hashes`, `content-validity`).
- Verifies RSA-SHA256 digital signatures (§6a, WebCrypto
  RSASSA-PKCS1-v1_5) when `security.json` declares them and rejects
  packages whose signature does not verify.
- Executes JS handler routes (§4a) as ES modules — see below.
- Serves §5a layered storage (top → bottom, `.capsium-tombstones` → 404).
- Serves §4a composite packages (dependency resources + route inheritance).
- Gates routes with §4b authentication (basicAuth / OAuth2 PKCE).

## Handler routes (§4a)

Routes declared as `{ "path": "/api/v1/echo", "method": "POST", "handler":
"content/handlers/echo.js" }` execute in the service worker: the handler
source is read from the package, imported as an ES module through a blob:
URL, and its default export (or named `fetch` export) is called with the
fetch-style `Request`; it must produce the `Response`:

```js
export default async (request) => new Response('echo');
```

- The route matches on both path and method; other methods get
  `405 Method Not Allowed` (with an `Allow` header).
- Sync and async handlers are supported; GET/POST/PUT/DELETE etc. all work
  (the original `Request`, including its body, is passed through).
- Error mapping: missing module / import failure / no callable entry /
  non-Response return → `502` with a clear body; a handler exception →
  `500`.
- Non-JS handlers (e.g. `.lua`) are **not** executed: this reactor answers
  `501` (§4a: JS handlers execute only in JS-capable reactors).
- Modules are cached per installed package (ES module semantics).

### Sandboxing caveats

A service worker has **no real sandbox**: handler code runs with the
worker's full privileges — same-origin `fetch`, Cache API, the installed
package bytes. Only install `.cap` packages from sources you trust, prefer
signed packages (§6a), and deploy a Content Security Policy on the page,
e.g. `script-src 'self' blob:; connect-src 'self'`, to constrain module
loading and exfiltration. Handler modules are imported from in-memory
blob: URLs only — never from the network.

## Layered storage (§5a)

Packages with `storage.layers` serve a merged view: layers are
package-relative directories mirroring the package tree, resolved **top →
bottom** (first hit wins); packages without a `layers` config behave as a
single implicit root layer. Deletions recorded in a layer's
`.capsium-tombstones` file (JSON array of merged-view paths) answer `404`
even when a lower layer still has the file. `visibility: private` layers
are served to the package itself but never exposed to dependent packages.

## Composite packages (§4a)

A package with `metadata.dependencies` (guid → semver range) can inherit
dependency content. The browser reactor has no store directory, so the
dependency `.cap` blobs are **supplied explicitly alongside the main
package** (e.g. the page's multi-file picker posts them with the install
message); they are verified and persisted like the main package.

- Resource routes may reference dependencies:
  `{ "path": "/vendor/app.js", "resource": "capsium://<guid>/content/app.js" }`.
  Only `exported` manifest resources are visible — referencing a
  dependency's `private` resource is rejected with a clear 404.
- Route inheritance attributes are honored at serve time: `remap`
  (the route is served at the remapped path), `responseRewrite`
  (`body` replacement, `headers` override), additive `responseHeaders`
  (never override), and `requestHeaders` (supplanted before forwarding
  to an inherited handler).

## Authentication (§4b)

`authentication.json` gates package routes (the introspection API stays
open):

- **basicAuth** — `401` + `WWW-Authenticate` challenge; the package's
  htpasswd file is verified in pure TS. Supported hash types: **bcrypt**
  (`$2a$`/`$2b$`/`$2y$`) and **apr1-MD5** (`$apr1$`). Anything else
  (sha-crypt, plaintext, ...) answers `501` with a precise body, as does
  a missing `passwdFile`.
- **oauth2** — browser-native authorization-code + **PKCE** (S256) flow.
  Provider config (clientId, authorization/token/userinfo URLs,
  `redirectPath`, scopes) comes from the package; the session-cookie
  signing secret comes from a **deploy-time config message** (`{type:
  'deploy-config', config: {sessionSecret}}`) — never from the package.
  OAuth2 without the deploy secret answers `501`. Sessions are
  HMAC-SHA256-signed cookies; PKCE pending state lives in memory, so a
  worker restart mid-login restarts the flow.
- Route-level `accessControl` on dataset routes is enforced after
  authentication (`401` unauthenticated, `403` unauthorized). htpasswd
  has no roles, so basic-auth principals are role-less; roles come from
  the OAuth2 userinfo profile.

## Files

- `src/sw.ts` — service worker entry (built to `dist/sw.js` as an IIFE).
- `src/resolver.ts` — pure routes.json path+method resolution (unit-tested).
- `src/fetch-handler.ts` — request pipeline (unit-tested with a mocked store).
- `src/handler-executor.ts` — §4a ES-module handler execution.
- `src/package-store.ts` — verification + Cache-API persistence (incl.
  composite dependencies).
- `src/auth/` — §4b: htpasswd (pure-TS MD5/apr1 + bcryptjs), PKCE flow,
  signed session cookies, the authentication gate.
- `index.html` — demo page with a `.cap` file picker.

## Try it

```sh
corepack yarn build          # produces dist/sw.js
npx serve packages/swsws     # any static server; serve the package dir
```

Open the page, pick a `.cap` (build one with `@capsium/packager`), then
browse `/`.
