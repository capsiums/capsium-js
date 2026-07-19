/**
 * Reactor-init error types. Loading, parse, decryption, dependency
 * resolution and signature errors are reused from @capsium/core and
 * @capsium/packager; §6 checksum failure gets its own type here because
 * verification reports a list of issues (data, not a single message).
 */
import { CapsiumError, type IntegrityIssue } from '@capsium/core';

/** §6 integrity verification failed at reactor init — the package is rejected. */
export class PackageIntegrityError extends CapsiumError {
  constructor(readonly issues: readonly IntegrityIssue[]) {
    super(
      `package integrity verification failed: ${issues
        .map((issue) => ('path' in issue ? `${issue.kind}: ${issue.path}` : issue.kind))
        .join('; ')}`,
    );
  }
}
