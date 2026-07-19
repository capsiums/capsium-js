/**
 * HMAC-SHA256-signed session cookie (§4b: "Session via signed cookie").
 * The signing secret comes from deploy-time configuration — never from
 * the package. Isomorphic (WebCrypto HMAC; Node's global subtle in tests).
 */

export const SESSION_COOKIE = 'capsium_session';

export interface AuthSession {
  readonly sub: string;
  readonly roles: readonly string[];
  /** Epoch milliseconds after which the session is invalid. */
  readonly expiresAt: number;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Signs and verifies session payloads with an HMAC-SHA256 secret. */
export class SessionCodec {
  private keyPromise: Promise<CryptoKey> | undefined;

  constructor(
    private readonly secret: string,
    private readonly subtle: SubtleCrypto = globalThis.crypto.subtle,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async encode(session: AuthSession): Promise<string> {
    const payload = base64urlEncode(encoder.encode(JSON.stringify(session)));
    const signature = await this.sign(payload);
    return `${payload}.${signature}`;
  }

  /** The verified session from a Cookie header, or undefined. */
  async decode(cookieHeader: string | null): Promise<AuthSession | undefined> {
    if (cookieHeader === null) {
      return undefined;
    }
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=');
      if (eq === -1 || part.slice(0, eq).trim() !== SESSION_COOKIE) {
        continue;
      }
      const value = part.slice(eq + 1).trim();
      const dot = value.lastIndexOf('.');
      if (dot === -1) {
        return undefined;
      }
      const payload = value.slice(0, dot);
      if ((await this.sign(payload)) !== value.slice(dot + 1)) {
        return undefined;
      }
      try {
        const session = JSON.parse(decoder.decode(base64urlDecode(payload))) as AuthSession;
        if (typeof session.sub !== 'string' || session.expiresAt < this.now()) {
          return undefined;
        }
        return { sub: session.sub, roles: session.roles ?? [], expiresAt: session.expiresAt };
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async sign(payload: string): Promise<string> {
    this.keyPromise ??= this.subtle.importKey(
      'raw',
      encoder.encode(this.secret) as BufferSource,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const signature = await this.subtle.sign(
      'HMAC',
      await this.keyPromise,
      encoder.encode(payload) as BufferSource,
    );
    return base64urlEncode(new Uint8Array(signature));
  }
}
