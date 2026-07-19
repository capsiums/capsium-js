import { execSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { apr1, htpasswdHashType, verifyHtpasswd } from '../src/auth/htpasswd.js';
import { md5 } from '../src/auth/md5.js';

const hasOpenssl = (() => {
  try {
    execSync('openssl version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

function md5Hex(value: string): string {
  return [...md5(new TextEncoder().encode(value))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('md5 (RFC 1321 vectors)', () => {
  it.each([
    ['', 'd41d8cd98f00b204e9800998ecf8427e'],
    ['a', '0cc175b9c0f1b6a831c399e269772661'],
    ['abc', '900150983cd24fb0d6963f7d28e17f72'],
    ['message digest', 'f96b697d7cb7938d525a2f31aaf161d0'],
    ['The quick brown fox jumps over the lazy dog', '9e107d9d372bb6826bd81d3542a419d6'],
  ])('md5(%j) matches the RFC vector', (input, expected) => {
    expect(md5Hex(input)).toBe(expected);
  });
});

describe('apr1 (openssl interop vectors)', () => {
  it.each([
    // Generated with: openssl passwd -apr1 -salt <salt> <password>
    ['swordfish', 'eWvS2f3d', '$apr1$eWvS2f3d$uvjLCQ9y6Om4aVryf5uSX.'],
    ['correct-horse', 'hfT7jp2q', '$apr1$hfT7jp2q$rGgmSkvPR0oWDyGsDluRW0'],
  ])('apr1(%j, %j) === %j', (password, salt, expected) => {
    expect(apr1(password, salt)).toBe(expected);
  });

  it.skipIf(!hasOpenssl)('matches openssl passwd -apr1 for fresh salts', () => {
    for (const [salt, password] of [
      ['Ab3dEf7h', 'p@ss w0rd'],
      ['00000000', ''],
      ['zzzzzzzz', 'a much longer password than sixteen bytes'],
    ] as const) {
      const expected = execSync(`openssl passwd -apr1 -salt ${salt} '${password}'`)
        .toString()
        .trim();
      expect(apr1(password, salt)).toBe(expected);
    }
  });
});

describe('verifyHtpasswd', () => {
  const htpasswd = [
    '# comment line',
    '',
    'alice:$apr1$eWvS2f3d$uvjLCQ9y6Om4aVryf5uSX.',
    'bob:$2b$10$beTezbKSP97h9uzvylruS.JWvFGpdmSYWbvF7XUZUCjhl/hVHkcwi',
    'carol:$6$rounds=5000$somesalt$SHA512cryptEntryHere',
  ].join('\n');

  it('verifies apr1 entries', async () => {
    await expect(verifyHtpasswd(htpasswd, 'alice', 'swordfish')).resolves.toEqual({
      kind: 'ok',
    });
    await expect(verifyHtpasswd(htpasswd, 'alice', 'wrong')).resolves.toEqual({
      kind: 'bad-credentials',
    });
  });

  it('verifies bcrypt entries', async () => {
    await expect(verifyHtpasswd(htpasswd, 'bob', 'swordfish')).resolves.toEqual({
      kind: 'ok',
    });
    await expect(verifyHtpasswd(htpasswd, 'bob', 'nope')).resolves.toEqual({
      kind: 'bad-credentials',
    });
  });

  it('reports unknown users', async () => {
    await expect(verifyHtpasswd(htpasswd, 'mallory', 'swordfish')).resolves.toEqual({
      kind: 'unknown-user',
    });
  });

  it('reports unsupported hash types precisely', async () => {
    await expect(verifyHtpasswd(htpasswd, 'carol', 'swordfish')).resolves.toEqual({
      kind: 'unsupported-hash',
      hashType: 'sha-crypt',
    });
  });

  it('detects hash type labels', () => {
    expect(htpasswdHashType('$apr1$salt$hash')).toBe('apr1');
    expect(htpasswdHashType('$2y$10$hash')).toBe('bcrypt');
    expect(htpasswdHashType('$6$salt$hash')).toBe('sha-crypt');
    expect(htpasswdHashType('plaintext')).toBe('unknown');
  });
});
