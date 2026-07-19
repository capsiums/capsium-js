/**
 * Package testing YAML DSL runner (05x-testing). Isomorphic — route tests
 * hit HTTP through an injectable fetch (a serving reactor in production, a
 * mock in tests).
 *
 * Test files live under `tests/` in the package (`*.yaml`/`*.yml`) and
 * hold a top-level `tests:` list. Test kinds (discriminated by `type`):
 * - `route`: fetch `url`, require `expected_status` and optional
 *   `response_contains` substring.
 * - `file`: require `path` to exist in the package.
 * - `data_validation`: validate `data_file` (json/yaml) against
 *   `schema_file` — a pragmatic JSON-Schema subset: `type`,
 *   `properties`, `required`, `items`, `enum`.
 * - `config`: require `config_file` to parse as `format` (json/yaml).
 *
 * Outcomes: `pass` | `fail` (an assertion did not hold) | `error` (the
 * test itself could not run: missing files, unparsable documents, fetch
 * failures, malformed test definitions).
 */
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { CapsiumPackage } from './package.js';

/** Directory scanned for YAML test files. */
export const PACKAGE_TESTS_DIR = 'tests/';

const routeTestSchema = z.object({
  name: z.string().min(1),
  type: z.literal('route'),
  url: z.string().min(1),
  expected_status: z.number().int(),
  response_contains: z.string().optional(),
});
const fileTestSchema = z.object({
  name: z.string().min(1),
  type: z.literal('file'),
  path: z.string().min(1),
});
const dataValidationTestSchema = z.object({
  name: z.string().min(1),
  type: z.literal('data_validation'),
  format: z.enum(['json', 'yaml']),
  data_file: z.string().min(1),
  schema_file: z.string().min(1),
});
const configTestSchema = z.object({
  name: z.string().min(1),
  type: z.literal('config'),
  format: z.enum(['json', 'yaml']),
  config_file: z.string().min(1),
});

export const packageTestSchema = z.discriminatedUnion('type', [
  routeTestSchema,
  fileTestSchema,
  dataValidationTestSchema,
  configTestSchema,
]);
export type PackageTest = z.infer<typeof packageTestSchema>;

const testFileSchema = z.object({
  tests: z.array(packageTestSchema),
});

export type PackageTestType = PackageTest['type'];
export type PackageTestStatus = 'pass' | 'fail' | 'error';

export interface PackageTestResult {
  readonly name: string;
  readonly type: PackageTestType | 'file-parse';
  readonly status: PackageTestStatus;
  readonly message?: string;
}

export interface PackageTestReport {
  /** Test files that ran (package-relative paths). */
  readonly files: readonly string[];
  readonly results: readonly PackageTestResult[];
  readonly passed: number;
  readonly failed: number;
  readonly errors: number;
}

export interface RunPackageTestsOptions {
  /** Explicit test files (package-relative); defaults to `tests/*.{yaml,yml}`. */
  readonly files?: readonly string[];
  /** Fetch used by route tests (defaults to globalThis.fetch). */
  readonly fetchFn?: (url: string) => Promise<{ status: number; bodyText: string }>;
}

const decoder = new TextDecoder();

function normalizePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}

/** Package-relative paths of the YAML test files to run. */
export function packageTestFiles(pkg: CapsiumPackage): string[] {
  return [...pkg.files.keys()]
    .filter(
      (path) =>
        path.startsWith(PACKAGE_TESTS_DIR) &&
        (path.endsWith('.yaml') || path.endsWith('.yml')) &&
        !path.slice(PACKAGE_TESTS_DIR.length).includes('/'),
    )
    .sort();
}

function parseData(format: 'json' | 'yaml', source: string): unknown {
  return format === 'json' ? (JSON.parse(source) as unknown) : (parseYaml(source) as unknown);
}

/* ------------------------------------------------------------------ */
/* Minimal JSON-Schema subset validator (type/properties/required/    */
/* items/enum) — documented scope of data_validation tests.           */
/* ------------------------------------------------------------------ */

function validateSchema(data: unknown, schema: unknown, path: string): string | null {
  if (typeof schema !== 'object' || schema === null) {
    return `schema at ${path} is not an object`;
  }
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s['enum']) && !(s['enum'] as unknown[]).includes(data)) {
    return `${path}: value is not one of the allowed enum values`;
  }

  if (typeof s['type'] === 'string') {
    const type = s['type'];
    const ok =
      (type === 'array' && Array.isArray(data)) ||
      (type === 'object' && typeof data === 'object' && data !== null && !Array.isArray(data)) ||
      (type === 'string' && typeof data === 'string') ||
      (type === 'number' && typeof data === 'number') ||
      (type === 'integer' && typeof data === 'number' && Number.isInteger(data)) ||
      (type === 'boolean' && typeof data === 'boolean') ||
      (type === 'null' && data === null);
    if (!ok) {
      return `${path}: expected type ${type}`;
    }
  }

  if (Array.isArray(data)) {
    if (s['items'] !== undefined) {
      for (const [index, item] of data.entries()) {
        const error = validateSchema(item, s['items'], `${path}[${index}]`);
        if (error !== null) {
          return error;
        }
      }
    }
    return null;
  }

  if (typeof data === 'object' && data !== null) {
    const record = data as Record<string, unknown>;
    for (const required of (s['required'] as string[] | undefined) ?? []) {
      if (!(required in record)) {
        return `${path}: missing required property "${required}"`;
      }
    }
    const properties = s['properties'] as Record<string, unknown> | undefined;
    if (properties !== undefined) {
      for (const [key, subschema] of Object.entries(properties)) {
        if (key in record) {
          const error = validateSchema(record[key], subschema, `${path}.${key}`);
          if (error !== null) {
            return error;
          }
        }
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */

async function runRouteTest(
  test: z.infer<typeof routeTestSchema>,
  fetchFn: NonNullable<RunPackageTestsOptions['fetchFn']>,
): Promise<PackageTestResult> {
  let status: number;
  let bodyText: string;
  try {
    ({ status, bodyText } = await fetchFn(test.url));
  } catch (error) {
    return {
      name: test.name,
      type: test.type,
      status: 'error',
      message: `request failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (status !== test.expected_status) {
    return {
      name: test.name,
      type: test.type,
      status: 'fail',
      message: `expected status ${test.expected_status}, got ${status}`,
    };
  }
  if (test.response_contains !== undefined && !bodyText.includes(test.response_contains)) {
    return {
      name: test.name,
      type: test.type,
      status: 'fail',
      message: `response does not contain ${JSON.stringify(test.response_contains)}`,
    };
  }
  return { name: test.name, type: test.type, status: 'pass' };
}

function readPackageText(pkg: CapsiumPackage, path: string): string | undefined {
  const bytes = pkg.files.get(normalizePath(path));
  return bytes === undefined ? undefined : decoder.decode(bytes);
}

function runOne(pkg: CapsiumPackage, test: PackageTest, fetchFn: NonNullable<RunPackageTestsOptions['fetchFn']>): Promise<PackageTestResult> {
  switch (test.type) {
    case 'route':
      return runRouteTest(test, fetchFn);
    case 'file': {
      const exists = pkg.files.has(normalizePath(test.path));
      return Promise.resolve({
        name: test.name,
        type: test.type,
        status: exists ? 'pass' : 'fail',
        ...(exists ? {} : { message: `file not found in package: ${test.path}` }),
      });
    }
    case 'data_validation': {
      const dataSource = readPackageText(pkg, test.data_file);
      if (dataSource === undefined) {
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: 'error',
          message: `data file not found in package: ${test.data_file}`,
        });
      }
      const schemaSource = readPackageText(pkg, test.schema_file);
      if (schemaSource === undefined) {
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: 'error',
          message: `schema file not found in package: ${test.schema_file}`,
        });
      }
      try {
        const data = parseData(test.format, dataSource);
        const schema = parseData(test.format, schemaSource);
        const violation = validateSchema(data, schema, '$');
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: violation === null ? 'pass' : 'fail',
          ...(violation !== null ? { message: violation } : {}),
        });
      } catch (error) {
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: 'error',
          message: `cannot parse ${test.format} document: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    case 'config': {
      const source = readPackageText(pkg, test.config_file);
      if (source === undefined) {
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: 'error',
          message: `config file not found in package: ${test.config_file}`,
        });
      }
      try {
        parseData(test.format, source);
        return Promise.resolve({ name: test.name, type: test.type, status: 'pass' });
      } catch (error) {
        return Promise.resolve({
          name: test.name,
          type: test.type,
          status: 'fail',
          message: `invalid ${test.format}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }
}

/**
 * Run the package's YAML test files (05x-testing) and return the aggregate
 * report. Individual tests never throw — problems are reported as
 * `error` results.
 */
export async function runPackageTests(
  pkg: CapsiumPackage,
  options: RunPackageTestsOptions = {},
): Promise<PackageTestReport> {
  const fetchFn =
    options.fetchFn ??
    (async (url: string) => {
      const response = await globalThis.fetch(url);
      return { status: response.status, bodyText: await response.text() };
    });
  const files = options.files ?? packageTestFiles(pkg);
  const results: PackageTestResult[] = [];

  for (const file of files) {
    const source = readPackageText(pkg, file);
    if (source === undefined) {
      results.push({
        name: file,
        type: 'file-parse',
        status: 'error',
        message: `test file not found in package: ${file}`,
      });
      continue;
    }
    let tests: PackageTest[];
    try {
      tests = testFileSchema.parse(parseYaml(source)).tests;
    } catch (error) {
      results.push({
        name: file,
        type: 'file-parse',
        status: 'error',
        message: `invalid test file: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    for (const test of tests) {
      results.push(await runOne(pkg, test, fetchFn));
    }
  }

  return {
    files,
    results,
    passed: results.filter((result) => result.status === 'pass').length,
    failed: results.filter((result) => result.status === 'fail').length,
    errors: results.filter((result) => result.status === 'error').length,
  };
}
