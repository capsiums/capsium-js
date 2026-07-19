/**
 * OAuth2 authorization-code flow with PKCE (§4b: browser reactors may use
 * PKCE; secrets come from deploy-time configuration — this flow is a
 * public client and needs no secret in the package at all). The token
 * exchange runs through an injectable fetch so tests can mock the
 * provider.
 *
 * Pending authorizations (state -> verifier) live in memory; a
 * service-worker restart mid-flow restarts the login (documented caveat).
 */
import type { OAuth2 } from '@capsium/core';
import { base64urlDecode, base64urlEncode, type AuthSession } from './session.js';
import { joinScopePrefix } from '../scope.js';

export interface OAuth2FlowOptions {
  readonly fetchFn?: typeof fetch;
  readonly random?: (bytes: number) => Uint8Array;
  readonly now?: () => number;
  /** Lifetime of a pending authorization (state/verifier), ms. */
  readonly pendingTtlMs?: number;
  /**
   * Registration scope pathname for non-root mounting: the redirect_uri
   * sent to the provider is prefixed with it so the callback lands back
   * inside the worker's scope. Default '/' (root scope).
   */
  readonly scopePrefix?: string;
}

interface PendingAuthorization {
  readonly verifier: string;
  readonly returnTo: string;
  readonly expiresAt: number;
}

export type CallbackOutcome =
  | { readonly kind: 'session'; readonly session: AuthSession; readonly returnTo: string }
  | { readonly kind: 'error'; readonly status: number; readonly message: string };

const DEFAULT_PENDING_TTL = 10 * 60 * 1000;

export class OAuth2Flow {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly fetchFn: typeof fetch;
  private readonly random: (bytes: number) => Uint8Array;
  private readonly now: () => number;
  private readonly pendingTtl: number;
  private readonly scopePrefix: string;

  constructor(
    private readonly config: OAuth2,
    private readonly sessionTtlMs: number,
    options: OAuth2FlowOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis);
    this.random =
      options.random ??
      ((bytes) => {
        const out = new Uint8Array(bytes);
        globalThis.crypto.getRandomValues(out);
        return out;
      });
    this.now = options.now ?? (() => Date.now());
    this.pendingTtl = options.pendingTtlMs ?? DEFAULT_PENDING_TTL;
    this.scopePrefix = options.scopePrefix ?? '/';
  }

  isCallback(pathname: string): boolean {
    return pathname === this.config.redirectPath;
  }

  /**
   * The callback URL the provider redirects to — prefixed with the
   * registration scope so it lands back inside this worker's scope.
   */
  private redirectUri(origin: string): string {
    return `${origin}${joinScopePrefix(this.scopePrefix, this.config.redirectPath)}`;
  }

  /** Build the PKCE authorization redirect (302) for an unauthenticated request. */
  async begin(requestUrl: string): Promise<Response> {
    const state = base64urlEncode(this.random(16));
    const verifier = base64urlEncode(this.random(32));
    const challenge = await this.pkceChallenge(verifier);
    const { origin } = new URL(requestUrl);
    this.pending.set(state, {
      verifier,
      // Full request pathname (including any scope prefix): the browser
      // returns here after the callback, back inside the worker's scope.
      returnTo: new URL(requestUrl).pathname,
      expiresAt: this.now() + this.pendingTtl,
    });
    const url = new URL(this.config.authorizationUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri(origin));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    if (this.config.scopes !== undefined && this.config.scopes.length > 0) {
      url.searchParams.set('scope', this.config.scopes.join(' '));
    }
    return new Response(null, { status: 302, headers: { Location: url.toString() } });
  }

  /** Handle the provider callback: verify state, exchange the code, open a session. */
  async handleCallback(requestUrl: string): Promise<CallbackOutcome> {
    const url = new URL(requestUrl);
    const { origin } = url;
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    if (state === null || code === null) {
      return { kind: 'error', status: 400, message: 'oauth2 callback requires code and state' };
    }
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (pending === undefined || pending.expiresAt < this.now()) {
      return { kind: 'error', status: 400, message: 'oauth2 state mismatch or expired' };
    }

    const tokenResponse = await this.fetchFn(this.config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.redirectUri(origin),
        client_id: this.config.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!tokenResponse.ok) {
      return {
        kind: 'error',
        status: 502,
        message: `oauth2 token exchange failed: HTTP ${tokenResponse.status}`,
      };
    }
    const tokens = (await tokenResponse.json()) as {
      access_token?: string;
      id_token?: string;
    };
    if (typeof tokens.access_token !== 'string') {
      return { kind: 'error', status: 502, message: 'oauth2 token response has no access_token' };
    }

    const identity = await this.identity(tokens.access_token, tokens.id_token);
    return {
      kind: 'session',
      session: {
        sub: identity.sub,
        roles: identity.roles,
        expiresAt: this.now() + this.sessionTtlMs,
      },
      returnTo: pending.returnTo,
    };
  }

  private async identity(
    accessToken: string,
    idToken: string | undefined,
  ): Promise<{ sub: string; roles: readonly string[] }> {
    const fromIdToken = idToken === undefined ? undefined : jwtSub(idToken);
    if (this.config.userinfoUrl === undefined) {
      return { sub: fromIdToken ?? 'oauth2-user', roles: [] };
    }
    const response = await this.fetchFn(this.config.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) {
      return { sub: fromIdToken ?? 'oauth2-user', roles: [] };
    }
    const profile = (await response.json()) as { sub?: unknown; roles?: unknown };
    return {
      sub: typeof profile.sub === 'string' ? profile.sub : (fromIdToken ?? 'oauth2-user'),
      roles:
        Array.isArray(profile.roles) && profile.roles.every((role) => typeof role === 'string')
          ? (profile.roles as string[])
          : [],
    };
  }

  private async pkceChallenge(verifier: string): Promise<string> {
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier) as BufferSource,
    );
    return base64urlEncode(new Uint8Array(digest));
  }
}

/** The `sub` claim of a JWT payload (unverified — identity proof is the code exchange). */
function jwtSub(jwt: string): string | undefined {
  const parts = jwt.split('.');
  if (parts.length !== 3 || parts[1] === undefined) {
    return undefined;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64urlDecode(parts[1]))) as {
      sub?: unknown;
    };
    return typeof payload.sub === 'string' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}
