/**
 * Reactor introspection reports (ARCHITECTURE.md §7) — the exact response
 * shapes every reactor converges on. With no package installed the list
 * shapes are answered empty (same behavior as the swsws reactor).
 */
import type {
  ContentHashesResponse,
  ContentValidityResponse,
  IntegrityReport,
  IntrospectMetadataResponse,
  IntrospectRoutesResponse,
  IntrospectionEndpoint,
} from '@capsium/core';
import type { InstalledPackage } from './store.js';

export type IntrospectionReport =
  | IntrospectMetadataResponse
  | IntrospectRoutesResponse
  | ContentHashesResponse
  | ContentValidityResponse;

function describeIssues(validity: IntegrityReport): string | undefined {
  if (validity.valid) {
    return undefined;
  }
  return validity.issues
    .map((issue) => ('path' in issue ? `${issue.kind}: ${issue.path}` : issue.kind))
    .join('; ');
}

/** The §7 report body for one introspection endpoint. */
export function introspectionReport(
  endpoint: IntrospectionEndpoint,
  installed: InstalledPackage | undefined,
): IntrospectionReport {
  switch (endpoint) {
    case 'metadata': {
      const body: IntrospectMetadataResponse = {
        packages:
          installed === undefined
            ? []
            : [
                {
                  name: installed.model.metadata.name,
                  version: installed.model.metadata.version,
                  description: installed.model.metadata.description,
                  ...(installed.model.metadata.author !== undefined
                    ? { author: installed.model.metadata.author }
                    : {}),
                },
              ],
      };
      return body;
    }
    case 'routes': {
      const body: IntrospectRoutesResponse = {
        routes:
          installed === undefined
            ? []
            : [
                {
                  package: installed.model.metadata.name,
                  routes: installed.model.routes.routes.map((route) => ({
                    method: 'handler' in route ? route.method : 'GET',
                    path: route.path,
                  })),
                },
              ],
      };
      return body;
    }
    case 'contentHashes': {
      const body: ContentHashesResponse = {
        contentHashes:
          installed === undefined
            ? []
            : [{ package: installed.model.metadata.name, hash: installed.contentHash }],
      };
      return body;
    }
    case 'contentValidity': {
      const reason = installed === undefined ? undefined : describeIssues(installed.validity);
      const body: ContentValidityResponse = {
        contentValidity:
          installed === undefined
            ? []
            : [
                {
                  package: installed.model.metadata.name,
                  valid: installed.validity.valid,
                  lastChecked: installed.validity.checkedAt,
                  ...(reason !== undefined ? { reason } : {}),
                },
              ],
      };
      return body;
    }
  }
}
