/**
 * Error types shared across Capsium packages.
 */
export class CapsiumError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** A package config file (metadata.json, manifest.json, ...) failed to parse or validate. */
export class PackageConfigError extends CapsiumError {
  constructor(
    readonly file: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super(`${file}: ${message}`, options);
  }
}

/** A required package file is absent. */
export class MissingPackageFileError extends CapsiumError {
  constructor(readonly file: string) {
    super(`required package file missing: ${file}`);
  }
}
