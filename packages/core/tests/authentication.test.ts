import { describe, expect, it } from 'vitest';
import {
  authenticationSchema,
  parseAuthentication,
  parsePackage,
  AUTHENTICATION_FILE,
} from '../src/index.js';
import { json, text, validMetadata } from './helpers.js';

const doc = {
  authentication: {
    basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd', realm: 'capsium' },
    oauth2: {
      enabled: true,
      provider: 'google',
      clientId: 'client-123',
      authorizationUrl: 'https://accounts.example.com/authorize',
      tokenUrl: 'https://accounts.example.com/token',
      userinfoUrl: 'https://accounts.example.com/userinfo',
      redirectPath: '/auth/callback',
      scopes: ['openid', 'email'],
    },
  },
};

describe('authenticationSchema (§4b)', () => {
  it('accepts a full authentication document', () => {
    expect(parseAuthentication(doc)).toEqual(doc);
  });

  it('accepts partial documents and rejects invalid ones', () => {
    expect(
      parseAuthentication({
        authentication: { basicAuth: { enabled: true, passwdFile: 'auth/.htpasswd' } },
      }).authentication.oauth2,
    ).toBeUndefined();
    expect(() =>
      authenticationSchema.parse({ authentication: { basicAuth: { enabled: true } } }),
    ).toThrow();
    expect(() =>
      authenticationSchema.parse({ authentication: { bogus: {} } }),
    ).toThrow();
    expect(() =>
      authenticationSchema.parse({
        authentication: {
          oauth2: {
            enabled: true,
            clientId: 'x',
            authorizationUrl: 'not-a-url',
            tokenUrl: 'https://ok.example/token',
            redirectPath: '/cb',
          },
        },
      }),
    ).toThrow();
  });

  it('parses authentication.json into the package model', () => {
    const files = new Map([
      ['metadata.json', json(validMetadata)],
      [AUTHENTICATION_FILE, json(doc)],
      ['content/index.html', text('<h1>x</h1>')],
    ]);
    const pkg = parsePackage(files);
    expect(pkg.authentication).toEqual(doc);
  });

  it('leaves authentication undefined without the file', () => {
    const files = new Map([
      ['metadata.json', json(validMetadata)],
      ['content/index.html', text('<h1>x</h1>')],
    ]);
    expect(parsePackage(files).authentication).toBeUndefined();
  });
});
