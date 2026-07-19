/**
 * Reactor init: load a package (directory, .cap archive, or an already-read
 * PackageReader model), verify §6 checksums and §6a signatures fail-fast
 * with typed errors, and resolve §4a composite dependencies from a package
 * store directory.
 *
 * Content hash (§7 content-hashes): the SHA-256 of the .cap blob when the
 * package was loaded from one. For directory sources (and in-memory models)
 * there is no blob, so — mirroring the Ruby reactor — the hash covers the
 * canonical (sorted-key) JSON serialization of the package checksums.
 */
import { readFile, stat } from 'node:fs/promises';
import {
  assertPackageSignature,
  computeChecksums,
  isEncryptedPackage,
  isPackageSigned,
  verifyIntegrity,
  DependencyResolutionError,
  type CapsiumPackage,
  type IntegrityReport,
} from '@capsium/core';
import {
  CapArchive,
  NodeHashProvider,
  NodeSignatureProvider,
  PackageReader,
  StoreDirectory,
} from '@capsium/packager';
import { PackageIntegrityError } from './errors.js';

/** A resolved §4a dependency, verified with the same gates as the main package. */
export interface LoadedDependency {
  readonly model: CapsiumPackage;
  readonly validity: IntegrityReport;
}

/** The verified package state the reactor serves from. */
export interface LoadedPackage {
  readonly model: CapsiumPackage;
  /** SHA-256 of the .cap blob, or of the canonical checksum set for directory sources. */
  readonly contentHash: string;
  readonly validity: IntegrityReport;
  /** §4a composite view: verified dependencies keyed by dependency guid. */
  readonly dependencies: ReadonlyMap<string, LoadedDependency>;
  /** §6a: the package declares a digital signature. */
  readonly signed: boolean;
  /** §6b: the package was loaded from an encrypted .cap (key required). */
  readonly encrypted: boolean;
}

export interface LoadPackageOptions {
  /** Package store directory (§4a) for composite dependency resolution. */
  readonly store?: string | undefined;
  /** RSA private key PEM for §6b encrypted packages. */
  readonly decryptionKeyPem?: string | undefined;
}

const hashProvider = new NodeHashProvider();
const signatureProvider = new NodeSignatureProvider();
const encoder = new TextEncoder();

/** §7 hash for blob-less sources: SHA-256 of the canonical checksum JSON. */
async function contentHashForFiles(files: ReadonlyMap<string, Uint8Array>): Promise<string> {
  const checksums = await computeChecksums(files, hashProvider);
  const sorted = Object.fromEntries(
    Object.entries(checksums).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return await hashProvider.digestHex(encoder.encode(JSON.stringify(sorted)));
}

/**
 * §6 gates, mirroring the swsws install semantics: packages without
 * security.json cannot be verified and are reported valid (verification
 * runs only when declared); signed packages are rejected on signature
 * mismatch (SignatureMismatchError, re-thrown from core); checksum issues
 * are rejected with PackageIntegrityError listing every issue.
 */
async function verifyModel(model: CapsiumPackage): Promise<IntegrityReport> {
  if (model.security === undefined) {
    return { valid: true, checkedAt: new Date().toISOString(), issues: [] };
  }
  if (isPackageSigned(model.security)) {
    await assertPackageSignature(model.files, model.security, signatureProvider);
  }
  const report = await verifyIntegrity(model.files, model.security, hashProvider);
  if (!report.valid) {
    throw new PackageIntegrityError(report.issues);
  }
  return report;
}

/** Resolve and verify §4a dependencies (newest satisfying store version each). */
async function loadDependencies(
  model: CapsiumPackage,
  store: string | undefined,
): Promise<ReadonlyMap<string, LoadedDependency>> {
  const declared = model.metadata.dependencies ?? {};
  const guids = Object.keys(declared);
  if (guids.length === 0) {
    return new Map();
  }
  if (store === undefined) {
    const wanted = guids.map((guid) => `${guid} (${declared[guid] ?? ''})`).join(', ');
    throw new DependencyResolutionError(
      `unsatisfiable package dependencies: ${wanted} (no package store configured)`,
    );
  }
  const resolved = await new StoreDirectory(store).loadDependencies(declared);
  const dependencies = new Map<string, LoadedDependency>();
  for (const [guid, dependencyModel] of resolved) {
    dependencies.set(guid, { model: dependencyModel, validity: await verifyModel(dependencyModel) });
  }
  return dependencies;
}

/**
 * Load and verify the reactor package. Typed init errors:
 * MissingPackageFileError / PackageConfigError (parse), EncryptedPackageError
 * (§6b key missing), DecryptionError (wrong key), SignatureError /
 * SignatureMismatchError (§6a), PackageIntegrityError (§6 checksums),
 * DependencyResolutionError (§4a store resolution).
 */
export async function loadPackage(
  source: string | CapsiumPackage,
  options: LoadPackageOptions = {},
): Promise<LoadedPackage> {
  const reader = new PackageReader();
  const readOptions =
    options.decryptionKeyPem !== undefined
      ? { decryptionKeyPem: options.decryptionKeyPem }
      : undefined;

  let model: CapsiumPackage;
  let contentHash: string;
  let encrypted = false;
  if (typeof source === 'string') {
    if ((await stat(source)).isDirectory()) {
      model = await reader.readDirectory(source, readOptions);
      contentHash = await contentHashForFiles(model.files);
    } else {
      const bytes = new Uint8Array(await readFile(source));
      // §6b detection needs the outer (possibly encrypted) archive layout;
      // readCapBytes unpacks again and decrypts transparently.
      encrypted = isEncryptedPackage(new CapArchive().unpack(bytes));
      model = await reader.readCapBytes(bytes, readOptions);
      contentHash = await hashProvider.digestHex(bytes);
    }
  } else {
    model = source;
    contentHash = await contentHashForFiles(model.files);
  }

  const validity = await verifyModel(model);
  const dependencies = await loadDependencies(model, options.store);
  const signed = model.security !== undefined && isPackageSigned(model.security);
  return { model, contentHash, validity, dependencies, signed, encrypted };
}
