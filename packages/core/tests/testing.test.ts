import { describe, expect, it } from 'vitest';
import {
  packageTestFiles,
  parsePackage,
  runPackageTests,
  type CapsiumPackage,
} from '../src/index.js';
import { json, text, validMetadata } from './helpers.js';

/**
 * Fixture mirrors the 05x-testing "Complete Example": route, file,
 * data_validation and config tests in one YAML document.
 */
const TESTS_YAML = `tests:
  - name: Home Route Test
    type: route
    url: "http://localhost:8000/"
    expected_status: 200
    response_contains: "Welcome"

  - name: API Route Test
    type: route
    url: "http://localhost:8000/api/v1/data/animals"
    expected_status: 200
    response_contains: "fox"

  - name: Failing Route Test
    type: route
    url: "http://localhost:8000/missing"
    expected_status: 200

  - name: Contains Mismatch Test
    type: route
    url: "http://localhost:8000/"
    expected_status: 200
    response_contains: "Goodbye"

  - name: Metadata File Exists
    type: file
    path: "metadata.json"

  - name: Data File Exists
    type: file
    path: "/data/animals.json"

  - name: Missing File Fails
    type: file
    path: "data/missing.json"

  - name: JSON Data Validation
    type: data_validation
    format: json
    data_file: "data/animals.json"
    schema_file: "data/animals.schema.json"

  - name: JSON Data Validation (violating)
    type: data_validation
    format: json
    data_file: "data/bad-animals.json"
    schema_file: "data/animals.schema.json"

  - name: YAML Data Validation
    type: data_validation
    format: yaml
    data_file: "data/animals.yaml"
    schema_file: "data/animals.schema.yaml"

  - name: JSON Config Validation
    type: config
    format: json
    config_file: "metadata.json"

  - name: Broken Config Fails
    type: config
    format: json
    config_file: "data/broken.json"

  - name: Missing Data File Errors
    type: data_validation
    format: json
    data_file: "data/nope.json"
    schema_file: "data/animals.schema.json"
`;

const ANIMALS_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: { type: 'string' }, legs: { type: 'integer' } },
    required: ['name'],
  },
};

const ANIMALS_SCHEMA_YAML = `type: array
items:
  type: object
  properties:
    name:
      type: string
  required:
    - name
`;

function fixturePackage(): CapsiumPackage {
  return parsePackage(
    new Map([
      ['metadata.json', json(validMetadata)],
      ['tests/package-tests.yaml', text(TESTS_YAML)],
      ['tests/unknown-type.yaml', text('tests:\n  - name: Bogus\n    type: teleport\n')],
      ['data/animals.json', json([{ name: 'fox', legs: 4 }, { name: 'bear' }])],
      ['data/bad-animals.json', json([{ legs: 4 }])],
      ['data/animals.schema.json', json(ANIMALS_SCHEMA)],
      ['data/animals.yaml', text('- name: fox\n- name: bear\n')],
      ['data/animals.schema.yaml', text(ANIMALS_SCHEMA_YAML)],
      ['data/broken.json', text('{not json')],
      ['content/index.html', text('<h1>Welcome</h1>')],
    ]),
  );
}

const responses: Record<string, { status: number; bodyText: string }> = {
  'http://localhost:8000/': { status: 200, bodyText: '<h1>Welcome</h1>' },
  'http://localhost:8000/api/v1/data/animals': {
    status: 200,
    bodyText: JSON.stringify([{ name: 'fox' }]),
  },
  'http://localhost:8000/missing': { status: 404, bodyText: 'not found' },
};

async function mockFetch(url: string): Promise<{ status: number; bodyText: string }> {
  const found = responses[url];
  if (found === undefined) {
    throw new Error(`no such URL: ${url}`);
  }
  return found;
}

describe('packageTestFiles', () => {
  it('discovers top-level YAML test files under tests/', () => {
    expect(packageTestFiles(fixturePackage())).toEqual([
      'tests/package-tests.yaml',
      'tests/unknown-type.yaml',
    ]);
  });
});

describe('runPackageTests (05x-testing)', () => {
  it('runs all four test kinds and aggregates pass/fail/error', async () => {
    const report = await runPackageTests(fixturePackage(), {
      files: ['tests/package-tests.yaml'],
      fetchFn: mockFetch,
    });
    expect(report.files).toEqual(['tests/package-tests.yaml']);
    const byName = new Map(report.results.map((result) => [result.name, result]));

    // route
    expect(byName.get('Home Route Test')).toMatchObject({ type: 'route', status: 'pass' });
    expect(byName.get('API Route Test')).toMatchObject({ status: 'pass' });
    expect(byName.get('Failing Route Test')).toMatchObject({
      status: 'fail',
      message: 'expected status 200, got 404',
    });
    expect(byName.get('Contains Mismatch Test')?.status).toBe('fail');

    // file
    expect(byName.get('Metadata File Exists')).toMatchObject({ type: 'file', status: 'pass' });
    expect(byName.get('Data File Exists')).toMatchObject({ status: 'pass' });
    expect(byName.get('Missing File Fails')).toMatchObject({
      status: 'fail',
      message: 'file not found in package: data/missing.json',
    });

    // data_validation
    expect(byName.get('JSON Data Validation')).toMatchObject({
      type: 'data_validation',
      status: 'pass',
    });
    const violating = byName.get('JSON Data Validation (violating)');
    expect(violating?.status).toBe('fail');
    expect(violating?.message).toContain('missing required property "name"');
    expect(byName.get('YAML Data Validation')).toMatchObject({ status: 'pass' });
    expect(byName.get('Missing Data File Errors')).toMatchObject({
      status: 'error',
      message: 'data file not found in package: data/nope.json',
    });

    // config
    expect(byName.get('JSON Config Validation')).toMatchObject({ type: 'config', status: 'pass' });
    expect(byName.get('Broken Config Fails')?.status).toBe('fail');

    expect(report.passed).toBe(7);
    expect(report.failed).toBe(5);
    expect(report.errors).toBe(1);
  });

  it('reports an error result for a malformed test file', async () => {
    const report = await runPackageTests(fixturePackage(), {
      files: ['tests/unknown-type.yaml'],
      fetchFn: mockFetch,
    });
    expect(report.errors).toBe(1);
    expect(report.results[0]).toMatchObject({ type: 'file-parse', status: 'error' });
    expect(report.results[0]?.message).toContain('invalid test file');
  });

  it('reports an error when a route request throws', async () => {
    const report = await runPackageTests(fixturePackage(), {
      files: ['tests/package-tests.yaml'],
      fetchFn: async () => {
        throw new Error('connection refused');
      },
    });
    const home = report.results.find((result) => result.name === 'Home Route Test');
    expect(home).toMatchObject({ status: 'error', message: 'request failed: connection refused' });
  });

  it('discovers test files itself when none are given', async () => {
    const report = await runPackageTests(fixturePackage(), { fetchFn: mockFetch });
    expect(report.files).toEqual(['tests/package-tests.yaml', 'tests/unknown-type.yaml']);
    expect(report.passed + report.failed + report.errors).toBe(report.results.length);
  });
});
