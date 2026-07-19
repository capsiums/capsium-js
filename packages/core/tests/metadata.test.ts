import { describe, expect, it } from 'vitest';
import { metadataSchema, parseMetadata } from '../src/index.js';
import { validMetadata } from './helpers.js';

describe('metadataSchema (§2)', () => {
  it('accepts a complete valid metadata document', () => {
    expect(metadataSchema.parse(validMetadata)).toEqual(validMetadata);
  });

  it('accepts the minimal required set', () => {
    const minimal = {
      name: 'a',
      version: '0.0.1',
      description: 'x',
      guid: 'https://example.com/x',
      uuid: '123e4567-e89b-12d3-a456-426614174000',
    };
    expect(metadataSchema.parse(minimal)).toEqual(minimal);
  });

  it.each([
    ['non kebab-case name', { name: 'Not_Kebab' }],
    ['non-semver version', { version: '1.0' }],
    ['missing description', { description: undefined }],
    ['invalid guid URI', { guid: 'not a uri' }],
    ['invalid uuid', { uuid: 'xyz' }],
  ])('rejects %s', (_label, override) => {
    const input = Object.fromEntries(
      Object.entries({ ...validMetadata, ...override }).filter(([, v]) => v !== undefined),
    );
    expect(() => metadataSchema.parse(input)).toThrow();
  });
});

describe('parseMetadata legacy normalization', () => {
  it('normalizes array-form dependencies to the object form', () => {
    const parsed = parseMetadata({
      ...validMetadata,
      dependencies: [
        { name: 'capsium://example.com/other-pkg', version: '>=1.0.0' },
        { name: 'capsium://example.com/second', version: '^2.1.3' },
      ],
    });
    expect(parsed.dependencies).toEqual({
      'capsium://example.com/other-pkg': '>=1.0.0',
      'capsium://example.com/second': '^2.1.3',
    });
  });

  it('keeps object-form dependencies untouched', () => {
    const parsed = parseMetadata(validMetadata);
    expect(parsed.dependencies).toEqual(validMetadata.dependencies);
  });

  it('rejects malformed legacy dependency entries', () => {
    expect(() =>
      parseMetadata({ ...validMetadata, dependencies: [{ name: 'x' }] }),
    ).toThrow();
  });
});
