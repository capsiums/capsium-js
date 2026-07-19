import { describe, expect, it } from 'vitest';
import {
  isSchemaFileDataset,
  isSqliteDataset,
  parseStorage,
  storageSchema,
} from '../src/index.js';

describe('storageSchema (§5)', () => {
  it('accepts both dataset kinds', () => {
    const storage = {
      storage: {
        dataSets: {
          animals: {
            source: 'data/animals.json',
            schemaFile: 'data/animals.schema.json',
            schemaType: 'json-schema',
          },
          sales: { databaseFile: 'data/sales.db', table: 'sales' },
        },
      },
    };
    const parsed = storageSchema.parse(storage);
    expect(parsed).toEqual(storage);
    const animals = parsed.storage.dataSets['animals'];
    const sales = parsed.storage.dataSets['sales'];
    expect(animals !== undefined && isSchemaFileDataset(animals)).toBe(true);
    expect(sales !== undefined && isSqliteDataset(sales)).toBe(true);
  });

  it('parses layers without behavior', () => {
    const parsed = storageSchema.parse({
      storage: { dataSets: {}, layers: [{ type: 'overlay', path: 'layer1' }] },
    });
    expect(parsed.storage.layers).toHaveLength(1);
  });

  it('rejects a sqlite dataset without table', () => {
    expect(() =>
      storageSchema.parse({ storage: { dataSets: { sales: { databaseFile: 'data/s.db' } } } }),
    ).toThrow();
  });

  it('rejects an empty dataset object', () => {
    expect(() => storageSchema.parse({ storage: { dataSets: { x: {} } } })).toThrow();
  });
});

describe('parseStorage legacy normalization', () => {
  it('normalizes the legacy {datasets: [...]} form (schema-file kind)', () => {
    const parsed = parseStorage({
      datasets: [
        {
          name: 'animals',
          source: 'data/animals.json',
          format: 'json-schema',
          schema: 'data/animals.schema.json',
        },
      ],
    });
    expect(parsed).toEqual({
      storage: {
        dataSets: {
          animals: {
            source: 'data/animals.json',
            schemaFile: 'data/animals.schema.json',
            schemaType: 'json-schema',
          },
        },
      },
    });
  });

  it('normalizes legacy sqlite entries', () => {
    const parsed = parseStorage({
      datasets: [{ name: 'sales', databaseFile: 'data/sales.db', table: 'sales' }],
    });
    expect(parsed.storage.dataSets['sales']).toEqual({
      databaseFile: 'data/sales.db',
      table: 'sales',
    });
  });

  it('rejects input matching neither form', () => {
    expect(() => parseStorage({ storage: { wrong: true } })).toThrow();
  });
});
