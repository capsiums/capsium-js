/**
 * Package installation and persistence for the Cloudflare Workers reactor.
 *
 * A .cap blob is verified at install time (SHA-256 checksums from
 * security.json, §6; RSASSA-PKCS1-v1_5 signature when declared, §6a) and
 * persisted UNZIPPED in the Cache API (`caches.default`) so the reactor
 * survives isolate restarts: every package file is stored under a
 * per-package synthetic request key, plus one small manifest entry listing
 * the stored files. Reinstalling first clears the previously installed
 * package's keys (atomic-ish: the manifest is written last, read first).
 *
 * The Cache API is per-colo and best-effort (entries may be evicted): the
 * store tolerates partial eviction on restore by re-running the full
 * verification and dropping a damaged install (the reactor then serves
 * 404s until the next install).
 */
import { unzipSync } from 'fflate';
import {
  assertPackageSignature,
  isPackageSigned,
  parsePackage,
  verifyIntegrity,
  MissingPackageFileError,
  PackageConfigError,
  SignatureError,
  type CapsiumPackage,
  type HashProvider,
  type IntegrityReport,
  type SignatureProvider,
} from '@capsium/core';
import { InstallRejection } from './errors.js';

/** The verified package state the reactor serves from. */
export interface InstalledPackage {
  readonly model: CapsiumPackage;
  /** SHA-256 of the .cap blob (§7 content-hashes). */
  readonly contentHash: string;
  readonly validity: IntegrityReport;
  /**
   * §4a composite view: dependency packages keyed by dependency guid.
   * This reactor installs a single .cap, so the map is always empty;
   * routes referencing a dependency answer 404.
   */
  readonly dependencies: ReadonlyMap<string, InstalledPackage>;
}

/** Small manifest entry persisted alongside the unzipped files. */
interface StoredManifest {
  readonly name: string;
  readonly version: string;
  readonly contentHash: string;
  readonly validity: IntegrityReport;
  readonly files: readonly string[];
}

/** Synthetic origin for Cache API keys (cache keys must be http(s) URLs). */
const CACHE_ORIGIN = 'https://reactor-cloudflare.capsium.internal';
const MANIFEST_KEY = `${CACHE_ORIGIN}/__capsium/manifest.json`;

function fileKey(name: string, path: string): string {
  return `${CACHE_ORIGIN}/__capsium/packages/${encodeURIComponent(name)}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

function unpackCap(capBytes: Uint8Array): Map<string, Uint8Array> {
  let unzipped: Record<string, Uint8Array>;
  try {
    unzipped = unzipSync(capBytes);
  } catch {
    throw InstallRejection.badRequest('invalid .cap archive (not a zip)');
  }
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(unzipped)) {
    if (!path.endsWith('/')) {
      files.set(path, data);
    }
  }
  return files;
}

export class CachePackageStore {
  private installed: InstalledPackage | undefined;

  constructor(
    private readonly cache: Cache,
    private readonly hashProvider: HashProvider,
    private readonly signatureProvider: SignatureProvider,
  ) {}

  get current(): InstalledPackage | undefined {
    return this.installed;
  }

  /**
   * Verify and install a .cap blob. Throws InstallRejection (400: malformed
   * archive/package config; 422: §6 checksum or §6a signature mismatch).
   * On success the previously installed package's cache keys are cleared
   * before the new files and manifest are written.
   */
  async install(capBytes: Uint8Array): Promise<InstalledPackage> {
    const installed = await this.verify(capBytes);
    if (!installed.validity.valid) {
      throw InstallRejection.integrityIssues(installed.validity.issues);
    }
    await this.clearStored();
    const name = installed.model.metadata.name;
    for (const [path, bytes] of installed.model.files) {
      await this.cache.put(fileKey(name, path), new Response(bytes as BodyInit));
    }
    const manifest: StoredManifest = {
      name,
      version: installed.model.metadata.version,
      contentHash: installed.contentHash,
      validity: installed.validity,
      files: [...installed.model.files.keys()],
    };
    await this.cache.put(
      MANIFEST_KEY,
      new Response(JSON.stringify(manifest), {
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    this.installed = installed;
    return installed;
  }

  /**
   * Restore a previously installed package after an isolate restart.
   * Returns undefined when nothing is stored or the stored package no
   * longer verifies (e.g. partially evicted from the cache); a damaged
   * install is dropped.
   */
  async restore(): Promise<InstalledPackage | undefined> {
    const manifestResponse = await this.cache.match(MANIFEST_KEY);
    if (manifestResponse === undefined) {
      return undefined;
    }
    const stored = (await manifestResponse.json()) as StoredManifest;
    const files = new Map<string, Uint8Array>();
    for (const path of stored.files) {
      const response = await this.cache.match(fileKey(stored.name, path));
      if (response === undefined) {
        // Partial cache eviction: the install is damaged, drop it.
        await this.clearStored();
        return undefined;
      }
      files.set(path, new Uint8Array(await response.arrayBuffer()));
    }
    let installed: InstalledPackage;
    try {
      const model = parsePackage(files);
      installed = {
        model,
        contentHash: stored.contentHash,
        validity: await this.verifyModel(model),
        dependencies: new Map(),
      };
    } catch {
      await this.clearStored();
      return undefined;
    }
    if (!installed.validity.valid) {
      await this.clearStored();
      return undefined;
    }
    this.installed = installed;
    return installed;
  }

  /** Forget the in-memory install and delete every stored key. */
  async clear(): Promise<void> {
    this.installed = undefined;
    await this.clearStored();
  }

  /** Delete the previously installed package's file keys and manifest. */
  private async clearStored(): Promise<void> {
    const manifestResponse = await this.cache.match(MANIFEST_KEY);
    if (manifestResponse !== undefined) {
      const stored = (await manifestResponse.json()) as StoredManifest;
      for (const path of stored.files) {
        await this.cache.delete(fileKey(stored.name, path));
      }
    }
    await this.cache.delete(MANIFEST_KEY);
  }

  /** Unzip, parse and run the §6/§6a verification gates. */
  private async verify(capBytes: Uint8Array): Promise<InstalledPackage> {
    let model: CapsiumPackage;
    try {
      model = parsePackage(unpackCap(capBytes));
    } catch (error) {
      if (error instanceof InstallRejection) {
        throw error;
      }
      if (error instanceof MissingPackageFileError || error instanceof PackageConfigError) {
        throw InstallRejection.badRequest(`invalid package: ${error.message}`);
      }
      throw error;
    }
    const validity = await this.verifyModel(model);
    const contentHash = await this.hashProvider.digestHex(capBytes);
    return { model, contentHash, validity, dependencies: new Map() };
  }

  /**
   * §6/§6a gates, mirroring the swsws install semantics: integrity
   * verification runs only when security.json is present; a declared
   * signature that does not verify rejects the install outright.
   */
  private async verifyModel(model: CapsiumPackage): Promise<IntegrityReport> {
    if (model.security !== undefined && isPackageSigned(model.security)) {
      try {
        await assertPackageSignature(model.files, model.security, this.signatureProvider);
      } catch (error) {
        if (error instanceof SignatureError) {
          throw InstallRejection.verificationFailed(
            `package signature verification failed: ${error.message}`,
          );
        }
        throw error;
      }
    }
    return model.security !== undefined
      ? await verifyIntegrity(model.files, model.security, this.hashProvider)
      : { valid: true, checkedAt: new Date().toISOString(), issues: [] };
  }
}
