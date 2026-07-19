/**
 * `createReactor` — the framework-agnostic Node reactor entry point.
 *
 * The returned handler has the Connect/Express middleware signature
 * `(req, res, next?)`, so it works with a plain `node:http` server AND
 * mounted into Express/Connect apps. The reactor owns the package's URL
 * space: unknown paths within it get a JSON 404 (it is a terminal handler,
 * not a filtering middleware). `next(err)` is invoked only for unexpected
 * internal errors; without a `next`, those become a JSON 500.
 *
 * Init is fail-fast: package loading, §6 integrity, §6a signatures and §4a
 * store resolution all complete (or throw typed errors) before the handler
 * is returned.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CapsiumPackage } from '@capsium/core';
import { loadPackage } from './loader.js';
import { ServingPipeline } from './serving.js';

/** Default Cache-Control for static resources (route-level headers override). */
export const DEFAULT_CACHE_CONTROL = 'public, max-age=31536000';

export interface CreateReactorOptions {
  /**
   * Package directory path, .cap archive path, or an already-read
   * PackageReader result (CapsiumPackage model).
   */
  readonly package: string | CapsiumPackage;
  /**
   * Package store directory (§4a) for composite dependency resolution.
   * Defaults to the CAPSIUM_STORE environment variable.
   */
  readonly store?: string;
  /** Cache-Control default for static resources (route headers override). */
  readonly cacheControl?: string;
  /** RSA private key PEM for §6b encrypted packages. */
  readonly decryptionKeyPem?: string;
}

/** Connect-style continuation; called only with an unexpected internal error. */
export type ReactorNext = (err?: unknown) => void;

/** Async Connect/Express-compatible request handler. */
export type ReactorHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: ReactorNext,
) => Promise<void>;

const ERROR_BASE_URL = 'http://capsium.reactor.invalid';

/**
 * Load, verify and serve a Capsium package. Throws typed init errors
 * (MissingPackageFileError, PackageConfigError, EncryptedPackageError,
 * DecryptionError, SignatureMismatchError, PackageIntegrityError,
 * DependencyResolutionError) before any request is served.
 */
export async function createReactor(options: CreateReactorOptions): Promise<ReactorHandler> {
  const store = options.store ?? process.env['CAPSIUM_STORE'];
  const loaded = await loadPackage(options.package, {
    ...(store !== undefined ? { store } : {}),
    ...(options.decryptionKeyPem !== undefined
      ? { decryptionKeyPem: options.decryptionKeyPem }
      : {}),
  });
  const pipeline = new ServingPipeline(loaded, options.cacheControl ?? DEFAULT_CACHE_CONTROL);

  return async (req, res, next) => {
    try {
      const method = (req.method ?? 'GET').toUpperCase();
      const pathname = new URL(req.url ?? '/', ERROR_BASE_URL).pathname;
      const response = pipeline.serve(pathname, method);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // HEAD: status and headers (incl. Content-Length) without a body.
      res.end(method === 'HEAD' ? undefined : response.body);
    } catch (error) {
      if (next !== undefined) {
        next(error);
        return;
      }
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal reactor error' }));
    }
  };
}
