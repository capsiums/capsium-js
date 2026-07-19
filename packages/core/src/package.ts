/**
 * Whole-package parsing: an in-memory file map (package-relative POSIX paths
 * -> bytes) validated into the canonical model. Isomorphic — no Node or
 * browser APIs — so both the Node packager and the browser reactor share it.
 *
 * When `manifest.json` or `routes.json` are absent they are auto-generated
 * per ARCHITECTURE.md §3-4.
 */
import { z } from 'zod';
import { MissingPackageFileError, PackageConfigError } from './errors.js';
import { parseMetadata, type Metadata } from './metadata.js';
import { parseManifest, type Manifest } from './manifest.js';
import { parseRoutes, type Routes } from './routes.js';
import { parseStorage, type Storage } from './storage.js';
import { parseSecurity, type Security } from './security.js';
import { parseAuthentication, type Authentication, AUTHENTICATION_FILE } from './authentication.js';
import { buildManifest } from './generate/manifest.js';
import { buildRoutes } from './generate/routes.js';
import { FALLBACK_MIME_TYPE, mimeTypeForPath } from './mime.js';

export const METADATA_FILE = 'metadata.json';
export const MANIFEST_FILE = 'manifest.json';
export const ROUTES_FILE = 'routes.json';
export const STORAGE_FILE = 'storage.json';

export interface CapsiumPackage {
  readonly metadata: Metadata;
  readonly manifest: Manifest;
  readonly routes: Routes;
  readonly storage?: Storage;
  readonly security?: Security;
  readonly authentication?: Authentication;
  /** Raw package bytes keyed by package-relative POSIX path. */
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export interface ParsePackageOptions {
  /**
   * MIME detection used when manifest.json must be auto-generated.
   * Defaults to the built-in extension table (`mimeTypeForPath`) with an
   * `application/octet-stream` fallback.
   */
  readonly mimeTypeFor?: (path: string) => string | undefined;
}

const decoder = new TextDecoder();

function readJson(files: ReadonlyMap<string, Uint8Array>, path: string): unknown | undefined {
  const bytes = files.get(path);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(decoder.decode(bytes)) as unknown;
  } catch (error) {
    throw new PackageConfigError(path, 'invalid JSON', { cause: error });
  }
}

function parseConfig<T>(file: string, input: unknown, parse: (value: unknown) => T): T {
  try {
    return parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new PackageConfigError(file, z.prettifyError(error), { cause: error });
    }
    throw error;
  }
}

/** Parse and validate a package file map into the canonical model. */
export function parsePackage(
  files: ReadonlyMap<string, Uint8Array>,
  options: ParsePackageOptions = {},
): CapsiumPackage {
  const metadataInput = readJson(files, METADATA_FILE);
  if (metadataInput === undefined) {
    throw new MissingPackageFileError(METADATA_FILE);
  }
  const metadata = parseConfig(METADATA_FILE, metadataInput, parseMetadata);

  const manifestInput = readJson(files, MANIFEST_FILE);
  const manifest =
    manifestInput !== undefined
      ? parseConfig(MANIFEST_FILE, manifestInput, parseManifest)
      : generateManifest(files, options);

  const storageInput = readJson(files, STORAGE_FILE);
  const storage =
    storageInput !== undefined ? parseConfig(STORAGE_FILE, storageInput, parseStorage) : undefined;

  const routesInput = readJson(files, ROUTES_FILE);
  const routes =
    routesInput !== undefined
      ? parseConfig(ROUTES_FILE, routesInput, parseRoutes)
      : buildRoutes(manifest, storage);

  const securityInput = readJson(files, 'security.json');
  const security =
    securityInput !== undefined ? parseConfig('security.json', securityInput, parseSecurity) : undefined;

  const authenticationInput = readJson(files, AUTHENTICATION_FILE);
  const authentication =
    authenticationInput !== undefined
      ? parseConfig(AUTHENTICATION_FILE, authenticationInput, parseAuthentication)
      : undefined;

  return {
    metadata,
    manifest,
    routes,
    ...(storage !== undefined ? { storage } : {}),
    ...(security !== undefined ? { security } : {}),
    ...(authentication !== undefined ? { authentication } : {}),
    files,
  };
}

function generateManifest(
  files: ReadonlyMap<string, Uint8Array>,
  options: ParsePackageOptions,
): Manifest {
  const detect = options.mimeTypeFor ?? mimeTypeForPath;
  const withMime = new Map<string, string>();
  for (const path of files.keys()) {
    withMime.set(path, detect(path) ?? FALLBACK_MIME_TYPE);
  }
  return buildManifest(withMime);
}
