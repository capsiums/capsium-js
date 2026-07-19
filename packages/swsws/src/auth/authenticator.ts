/**
 * The §4b authentication gate for the swsws reactor. One Authenticator per
 * installed package (holds PKCE pending state and the session codec).
 *
 * Request flow:
 *  1. A valid signed session cookie authenticates (OAuth2 sessions).
 *  2. An `Authorization: Basic` header is verified against the package's
 *     htpasswd file (bcrypt/apr1 — see htpasswd.ts for supported types).
 *  3. Otherwise: OAuth2 enabled → PKCE authorization redirect; only
 *     basicAuth enabled → 401 challenge.
 *
 * 501 with a precise body for unsupported combos: missing htpasswd file,
 * unsupported htpasswd hash types, and OAuth2 without a deploy-time
 * session secret (secrets never come from the package).
 */
import {
  DEFAULT_BASIC_REALM,
  type Authentication,
  type BasicAuth,
  type OAuth2,
} from '@capsium/core';
import { verifyHtpasswd } from './htpasswd.js';
import { OAuth2Flow, type OAuth2FlowOptions } from './oauth2.js';
import { SESSION_COOKIE, SessionCodec, type AuthSession } from './session.js';
import { textResponse } from '../responses.js';

/** Secrets supplied at deploy time (deploy.json / deploy config message). */
export interface DeployAuthConfig {
  /** HMAC-SHA256 secret signing session cookies. Required for OAuth2. */
  readonly sessionSecret?: string;
}

export interface AuthPrincipal {
  readonly sub: string;
  readonly roles: readonly string[];
}

export interface GateOutcome {
  /** Challenge/redirect/error response — when set, the request is gated. */
  readonly response?: Response;
  /** The authenticated principal when the request is allowed. */
  readonly principal?: AuthPrincipal;
}

export interface AuthenticatorOptions extends OAuth2FlowOptions {
  readonly deployConfig?: DeployAuthConfig;
  /** Session cookie lifetime, seconds (default 8h). */
  readonly sessionTtlSeconds?: number;
}

const DEFAULT_SESSION_TTL = 8 * 60 * 60;

const decoder = new TextDecoder();

function basicChallenge(realm: string): Response {
  return new Response('authentication required', {
    status: 401,
    headers: {
      'Content-Type': 'text/plain',
      'WWW-Authenticate': `Basic realm="${realm}", charset="UTF-8"`,
    },
  });
}

/** Parse `Authorization: Basic base64(user:password)`. */
export function parseBasicCredentials(request: Request): { user: string; password: string } | null {
  const header = request.headers.get('Authorization');
  if (header === null || !header.startsWith('Basic ')) {
    return null;
  }
  try {
    const decoded = atob(header.slice('Basic '.length));
    const colon = decoded.indexOf(':');
    if (colon === -1) {
      return null;
    }
    return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

export class Authenticator {
  private readonly basic: BasicAuth | undefined;
  private readonly oauth2: OAuth2 | undefined;
  private readonly sessionTtlMs: number;
  private flow: OAuth2Flow | undefined;
  private codec: SessionCodec | undefined;

  constructor(
    authentication: Authentication,
    private readonly files: ReadonlyMap<string, Uint8Array>,
    private readonly options: AuthenticatorOptions = {},
  ) {
    this.basic = authentication.authentication.basicAuth?.enabled === true
      ? authentication.authentication.basicAuth
      : undefined;
    this.oauth2 = authentication.authentication.oauth2?.enabled === true
      ? authentication.authentication.oauth2
      : undefined;
    this.sessionTtlMs = (options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL) * 1000;
  }

  /** True when authentication is enabled in any form. */
  get enabled(): boolean {
    return this.basic !== undefined || this.oauth2 !== undefined;
  }

  isOAuth2Callback(pathname: string): boolean {
    return this.oauth2 !== undefined && pathname === this.oauth2.redirectPath;
  }

  /** Handle the OAuth2 callback request (token exchange, session cookie). */
  async handleCallback(request: Request): Promise<Response> {
    const flow = this.oauth2Flow();
    if (flow === undefined) {
      return textResponse('oauth2 callback for a package without oauth2', 404);
    }
    if (this.sessionCodec() === undefined) {
      return this.oauth2SecretMissing();
    }
    const outcome = await flow.handleCallback(request.url);
    if (outcome.kind === 'error') {
      return textResponse(outcome.message, outcome.status);
    }
    const codec = this.sessionCodec();
    if (codec === undefined) {
      return this.oauth2SecretMissing();
    }
    const cookie = await codec.encode(outcome.session);
    return new Response(null, {
      status: 302,
      headers: {
        Location: outcome.returnTo,
        'Set-Cookie':
          `${SESSION_COOKIE}=${cookie}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(this.sessionTtlMs / 1000)}`,
      },
    });
  }

  /** Gate one request: undefined response + principal means "allowed". */
  async gate(request: Request): Promise<GateOutcome> {
    // 1. Signed session cookie (OAuth2 sessions).
    const session = await this.sessionFrom(request);
    if (session !== undefined) {
      return { principal: { sub: session.sub, roles: session.roles } };
    }
    // 2. HTTP Basic credentials.
    const credentials = parseBasicCredentials(request);
    if (credentials !== null) {
      return await this.basicOutcome(credentials);
    }
    // 3. No credentials: redirect to the provider or challenge.
    if (this.oauth2 !== undefined) {
      const flow = this.oauth2Flow();
      if (this.sessionCodec() === undefined || flow === undefined) {
        return { response: this.oauth2SecretMissing() };
      }
      return { response: await flow.begin(request.url) };
    }
    if (this.basic !== undefined) {
      return { response: basicChallenge(this.basic.realm ?? DEFAULT_BASIC_REALM) };
    }
    return {};
  }

  private async basicOutcome(credentials: {
    user: string;
    password: string;
  }): Promise<GateOutcome> {
    if (this.basic === undefined) {
      return { response: basicChallenge(DEFAULT_BASIC_REALM) };
    }
    const htpasswdBytes = this.files.get(this.basic.passwdFile);
    if (htpasswdBytes === undefined) {
      return {
        response: textResponse(
          `basicAuth passwdFile missing from package: ${this.basic.passwdFile}`,
          501,
        ),
      };
    }
    const verification = await verifyHtpasswd(
      decoder.decode(htpasswdBytes),
      credentials.user,
      credentials.password,
    );
    switch (verification.kind) {
      case 'ok':
        // htpasswd carries no roles — basic principals are role-less.
        return { principal: { sub: credentials.user, roles: [] } };
      case 'unsupported-hash':
        return {
          response: textResponse(
            `htpasswd hash type not supported by this reactor: ${verification.hashType} (supported: bcrypt, apr1)`,
            501,
          ),
        };
      default:
        return { response: basicChallenge(this.basic.realm ?? DEFAULT_BASIC_REALM) };
    }
  }

  private oauth2SecretMissing(): Response {
    return textResponse(
      'oauth2 requires a deploy-time session secret (deploy config) — secrets never come from the package',
      501,
    );
  }

  private async sessionFrom(request: Request): Promise<AuthSession | undefined> {
    const codec = this.sessionCodec();
    if (codec === undefined) {
      return undefined;
    }
    return await codec.decode(request.headers.get('Cookie'));
  }

  private sessionCodec(): SessionCodec | undefined {
    const secret = this.options.deployConfig?.sessionSecret;
    if (secret === undefined) {
      return undefined;
    }
    this.codec ??= new SessionCodec(secret, globalThis.crypto.subtle, this.options.now);
    return this.codec;
  }

  private oauth2Flow(): OAuth2Flow | undefined {
    if (this.oauth2 === undefined) {
      return undefined;
    }
    this.flow ??= new OAuth2Flow(this.oauth2, this.sessionTtlMs, {
      ...(this.options.fetchFn !== undefined ? { fetchFn: this.options.fetchFn } : {}),
      ...(this.options.random !== undefined ? { random: this.options.random } : {}),
      ...(this.options.now !== undefined ? { now: this.options.now } : {}),
      ...(this.options.pendingTtlMs !== undefined
        ? { pendingTtlMs: this.options.pendingTtlMs }
        : {}),
      ...(this.options.scopePrefix !== undefined ? { scopePrefix: this.options.scopePrefix } : {}),
    });
    return this.flow;
  }
}
