/**
 * Package installation and persistence for the service-worker reactor.
 *
 * A .cap blob is verified (SHA-256 checksums from security.json, §6) at
 * install time and persisted in the Cache API so the reactor survives
 * service-worker restarts. Verified packages are unpacked in memory and
 * served from there.
 */
import { unzipSync } from 'fflate';
import {
  assertPackageSignature,
  isPackageSigned,
  parsePackage,
  verifyIntegrity,
  CapsiumError,
  SignatureError,
  type CapsiumPackage,
  type HashProvider,
  type IntegrityIssue,
  type IntegrityReport,
  type SignatureProvider,
} from '@capsium/core';

export class PackageIntegrityError extends CapsiumError {
  constructor(readonly issues: readonly IntegrityIssue[]) {
    super(`package integrity verification failed: ${issues.map((issue) => issue.kind).join(', ')}`);
  }
}

/** The declared §6a digital signature could not be verified at install time. */
export class PackageSignatureError extends CapsiumError {}

/** Minimal blob persistence so tests can substitute an in-memory fake. */
export interface KeyValueBlobCache {
  put(key: string, data: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

const CAP_KEY = '/capsium/current.cap';
const DEPS_KEY = '/capsium/deps.index.json';

function depKey(index: number): string {
  return `/capsium/deps/${index}.cap`;
}

/** KeyValueBlobCache backed by the Cache API. */
export class CacheApiBlobCache implements KeyValueBlobCache {
  constructor(private readonly cache: Cache) {}

  async put(key: string, data: Uint8Array): Promise<void> {
    await this.cache.put(key, new Response(data as BodyInit));
  }

  async get(key: string): Promise<Uint8Array | undefined> {
    const response = await this.cache.match(key);
    if (response === undefined) {
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async delete(key: string): Promise<void> {
    await this.cache.delete(key);
  }
}

export interface InstalledPackage {
  readonly model: CapsiumPackage;
  /** SHA-256 of the .cap blob (§7 content-hashes). */
  readonly contentHash: string;
  readonly validity: IntegrityReport;
  /**
   * §4a composite view: installed dependency packages keyed by dependency
   * guid (supplied explicitly, e.g. via the page's .cap picker).
   */
  readonly dependencies: ReadonlyMap<string, InstalledPackage>;
}

function unpackCap(capBytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  for (const [path, data] of Object.entries(unzipSync(capBytes))) {
    if (!path.endsWith('/')) {
      files.set(path, data);
    }
  }
  return files;
}

export class PackageStore {
  private installed: InstalledPackage | undefined;

  constructor(
    private readonly blobs: KeyValueBlobCache,
    private readonly hashProvider: HashProvider,
    private readonly signatureProvider?: SignatureProvider,
  ) {}

  get current(): InstalledPackage | undefined {
    return this.installed;
  }

  /**
   * Verify and install a .cap blob, with its dependency packages supplied
   * explicitly (§4a composite packages — the browser reactor has no store
   * directory, so dependents are picked alongside the main package).
   * Throws PackageIntegrityError when security.json checksums do not match
   * (§6: reactors MUST reject).
   */
  async install(
    capBytes: Uint8Array,
    dependencies: ReadonlyMap<string, Uint8Array> = new Map(),
  ): Promise<InstalledPackage> {
    const installed = await this.verifyComposite(capBytes, dependencies);
    if (!installed.validity.valid) {
      throw new PackageIntegrityError(installed.validity.issues);
    }
    await this.blobs.put(CAP_KEY, capBytes);
    const guids = [...dependencies.keys()];
    await this.blobs.put(DEPS_KEY, new TextEncoder().encode(JSON.stringify(guids)));
    let index = 0;
    for (const depBytes of dependencies.values()) {
      await this.blobs.put(depKey(index), depBytes);
      index += 1;
    }
    this.installed = installed;
    return installed;
  }

  /** Restore a previously installed package (e.g. after a worker restart). */
  async restore(): Promise<InstalledPackage | undefined> {
    const capBytes = await this.blobs.get(CAP_KEY);
    if (capBytes === undefined) {
      return undefined;
    }
    const dependencies = new Map<string, Uint8Array>();
    const indexBytes = await this.blobs.get(DEPS_KEY);
    if (indexBytes !== undefined) {
      const guids = JSON.parse(new TextDecoder().decode(indexBytes)) as string[];
      for (const [index, guid] of guids.entries()) {
        const depBytes = await this.blobs.get(depKey(index));
        if (depBytes !== undefined) {
          dependencies.set(guid, depBytes);
        }
      }
    }
    const installed = await this.verifyComposite(capBytes, dependencies);
    if (!installed.validity.valid) {
      await this.blobs.delete(CAP_KEY);
      throw new PackageIntegrityError(installed.validity.issues);
    }
    this.installed = installed;
    return installed;
  }

  async clear(): Promise<void> {
    this.installed = undefined;
    await this.blobs.delete(CAP_KEY);
    await this.blobs.delete(DEPS_KEY);
  }

  private async verifyComposite(
    capBytes: Uint8Array,
    dependencies: ReadonlyMap<string, Uint8Array>,
  ): Promise<InstalledPackage> {
    const installed = await this.verify(capBytes);
    if (dependencies.size === 0) {
      return installed;
    }
    const resolved = new Map<string, InstalledPackage>();
    for (const [guid, depBytes] of dependencies) {
      const dependency = await this.verify(depBytes);
      if (!dependency.validity.valid) {
        throw new PackageIntegrityError(dependency.validity.issues);
      }
      resolved.set(guid, dependency);
    }
    return { ...installed, dependencies: resolved };
  }

  private async verify(capBytes: Uint8Array): Promise<InstalledPackage> {
    const model = parsePackage(unpackCap(capBytes));
    const validity = model.security
      ? await verifyIntegrity(model.files, model.security, this.hashProvider)
      : { valid: true, checkedAt: new Date().toISOString(), issues: [] };
    if (model.security !== undefined && isPackageSigned(model.security)) {
      await this.verifySignature(model);
    }
    const contentHash = await this.hashProvider.digestHex(capBytes);
    return { model, contentHash, validity, dependencies: new Map() };
  }

  /** §6a gate: signed packages install only when the signature verifies. */
  private async verifySignature(model: CapsiumPackage): Promise<void> {
    if (model.security === undefined || this.signatureProvider === undefined) {
      throw new PackageSignatureError(
        'package declares digitalSignatures but no SignatureProvider is configured',
      );
    }
    try {
      await assertPackageSignature(model.files, model.security, this.signatureProvider);
    } catch (error) {
      if (error instanceof SignatureError) {
        throw new PackageSignatureError(error.message, { cause: error });
      }
      throw error;
    }
  }
}
