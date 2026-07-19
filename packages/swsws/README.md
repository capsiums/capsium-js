# swsws — service worker static website server

The browser Capsium reactor (`@capsium/swsws`): a dependency-light, hand-rolled
service worker that serves `.cap` packages straight from the zip.

- Accepts a `.cap` blob from the page via `postMessage`, verifies SHA-256
  checksums against `security.json` (WebCrypto) and rejects tampered packages.
- Persists the verified blob in the Cache API and serves requests per
  `routes.json` (auto-generated routes included), unpacking entries with fflate.
- Answers the reactor introspection API under `/api/v1/introspect/`
  (`metadata`, `routes`, `content-hashes`, `content-validity`).

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
