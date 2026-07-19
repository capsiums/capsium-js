/**
 * Reactor introspection reports (ARCHITECTURE.md §7) — the exact response
 * shapes every reactor converges on, each wrapping the single served
 * package in the list shape.
 */
import type {
  ContentHashesResponse,
  ContentValidityResponse,
  IntegrityReport,
  IntrospectMetadataResponse,
  IntrospectRoutesResponse,
  IntrospectionEndpoint,
} from '@capsium/core';
import type { LoadedPackage } from './loader.js';

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
  loaded: LoadedPackage,
): IntrospectionReport {
  const { model } = loaded;
  switch (endpoint) {
    case 'metadata': {
      const body: IntrospectMetadataResponse = {
        packages: [
          {
            name: model.metadata.name,
            version: model.metadata.version,
            description: model.metadata.description,
            ...(model.metadata.author !== undefined ? { author: model.metadata.author } : {}),
          },
        ],
      };
      return body;
    }
    case 'routes': {
      const body: IntrospectRoutesResponse = {
        routes: [
          {
            package: model.metadata.name,
            routes: model.routes.routes.map((route) => ({
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
        contentHashes: [{ package: model.metadata.name, hash: loaded.contentHash }],
      };
      return body;
    }
    case 'contentValidity': {
      const reason = describeIssues(loaded.validity);
      const body: ContentValidityResponse = {
        contentValidity: [
          {
            package: model.metadata.name,
            valid: loaded.validity.valid,
            lastChecked: loaded.validity.checkedAt,
            ...(reason !== undefined ? { reason } : {}),
          },
        ],
      };
      return body;
    }
  }
}
