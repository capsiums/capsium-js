# swsws — service worker static website server

The browser Capsium reactor (`@capsium/swsws`): a dependency-light, hand-rolled
service worker that serves `.cap` packages straight from the zip.

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

## Files

- `src/sw.ts` — service worker entry (built to `dist/sw.js` as an IIFE).
- `src/resolver.ts` — pure routes.json path resolution (unit-tested).
- `src/fetch-handler.ts` — request pipeline (unit-tested with a mocked store).
- `src/package-store.ts` — verification + Cache-API persistence.
- `index.html` — demo page with a `.cap` file picker.

## Try it

```sh
corepack yarn build          # produces dist/sw.js
npx serve packages/swsws     # any static server; serve the package dir
```

Open the page, pick a `.cap` (build one with `@capsium/packager`), then
browse `/`.
