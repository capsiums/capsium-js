import { describe, expect, it } from 'vitest';
import { manifestSchema, parseManifest, resourceVisibility } from '../src/index.js';

describe('manifestSchema (§3)', () => {
  it('accepts the canonical object form', () => {
    const manifest = {
      resources: {
        'content/index.html': { type: 'text/html', visibility: 'exported' },
        'content/styles.css': { type: 'text/css', version: '1.2.3' },
      },
    };
    expect(manifestSchema.parse(manifest)).toEqual(manifest);
  });

  it('rejects a resource without a MIME type', () => {
    expect(() =>
      manifestSchema.parse({ resources: { 'content/a.txt': { visibility: 'exported' } } }),
    ).toThrow();
  });

  it('rejects an invalid visibility value', () => {
    expect(() =>
      manifestSchema.parse({ resources: { 'content/a.txt': { type: 'text/plain', visibility: 'hidden' } } }),
    ).toThrow();
  });

  it('defaults visibility to exported via resourceVisibility()', () => {
    expect(resourceVisibility({ type: 'text/css' })).toBe('exported');
    expect(resourceVisibility({ type: 'text/css', visibility: 'private' })).toBe('private');
  });
});

describe('parseManifest legacy normalization', () => {
  it('normalizes the legacy {content: [{file, mime}]} form', () => {
    const parsed = parseManifest({
      content: [
        { file: 'content/index.html', mime: 'text/html' },
        { file: 'content/app.js', mime: 'text/javascript' },
      ],
    });
    expect(parsed).toEqual({
      resources: {
        'content/index.html': { type: 'text/html' },
        'content/app.js': { type: 'text/javascript' },
      },
    });
  });

  it('prefers the canonical form when both shapes are present', () => {
    const parsed = parseManifest({
      resources: { 'content/index.html': { type: 'text/html' } },
      content: [{ file: 'content/ignored.js', mime: 'text/javascript' }],
    });
    expect(Object.keys(parsed.resources)).toEqual(['content/index.html']);
  });

  it('rejects input matching neither form', () => {
    expect(() => parseManifest({ nope: true })).toThrow();
  });
});
