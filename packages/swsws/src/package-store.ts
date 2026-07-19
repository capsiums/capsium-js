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
   * Verify and install a .cap blob. Throws PackageIntegrityError when
   * security.json checksums do not match (§6: reactors MUST reject).
   */
  async install(capBytes: Uint8Array): Promise<InstalledPackage> {
    const installed = await this.verify(capBytes);
    if (!installed.validity.valid) {
      throw new PackageIntegrityError(installed.validity.issues);
    }
    await this.blobs.put(CAP_KEY, capBytes);
    this.installed = installed;
    return installed;
  }

  /** Restore a previously installed package (e.g. after a worker restart). */
  async restore(): Promise<InstalledPackage | undefined> {
    const capBytes = await this.blobs.get(CAP_KEY);
    if (capBytes === undefined) {
      return undefined;
    }
    const installed = await this.verify(capBytes);
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
    return { model, contentHash, validity };
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
