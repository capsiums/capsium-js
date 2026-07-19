/**
 * Typed install rejections (ARCHITECTURE.md §6/§6a gates applied at install
 * time). The worker maps these to JSON problem bodies `{error}` with the
 * carried HTTP status; unexpected errors become a plain 500.
 */
import { CapsiumError, type IntegrityIssue } from '@capsium/core';

function describeIssue(issue: IntegrityIssue): string {
  return 'path' in issue ? `${issue.kind}: ${issue.path}` : issue.kind;
}

/** A .cap upload rejected before installation (malformed or failed verification). */
export class InstallRejection extends CapsiumError {
  constructor(
    message: string,
    /** HTTP status the install endpoint answers with (4xx). */
    readonly status: 400 | 422,
  ) {
    super(message);
  }

  /** The request body was not a readable .cap archive / package. */
  static badRequest(message: string): InstallRejection {
    return new InstallRejection(message, 400);
  }

  /** §6 checksum or §6a signature verification failed (message names the reason). */
  static verificationFailed(message: string): InstallRejection {
    return new InstallRejection(message, 422);
  }

  static integrityIssues(issues: readonly IntegrityIssue[]): InstallRejection {
    return InstallRejection.verificationFailed(
      `package integrity verification failed: ${issues.map(describeIssue).join('; ')}`,
    );
  }
}
