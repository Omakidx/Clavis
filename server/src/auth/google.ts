import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { pkceChallenge } from './crypto';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
const CLOCK_SKEW_S = 300;

/** Sign-in failed because of the code, token or claims (client error). */
export class GoogleAuthError extends Error {
  constructor(
    public readonly kind: 'oauth_failed' | 'email_not_verified',
    message: string,
  ) {
    super(message);
    this.name = 'GoogleAuthError';
  }
}
/** Google could not be reached or answered 5xx (retryable, maps to 503). */
export class GoogleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleUnavailableError';
  }
}

export interface GoogleIdentity {
  sub: string;
  email: string;
  displayName: string | null;
}

export interface GoogleClientOptions {
  clientId: string;
  clientSecret: string;
  /** Test seam: replaces global fetch for the token endpoint. */
  fetch?: typeof fetch;
  /** Test seam: replaces the remote Google JWKS. */
  jwks?: JWTVerifyGetKey;
  now?: () => number;
  timeoutMs?: number;
}

export interface AuthUrlParams {
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  reauth?: boolean;
}

const TokenResponse = z.looseObject({ id_token: z.string().min(1) });
const Claims = z.looseObject({
  sub: z.string().min(1).max(255),
  email: z.string().min(1).max(320).optional(),
  email_verified: z.union([z.boolean(), z.enum(['true', 'false'])]).optional(),
  name: z.string().optional(),
  nonce: z.string().optional(),
  iat: z.number(),
});

export class GoogleClient {
  private readonly fetchFn: typeof fetch;
  private readonly jwks: JWTVerifyGetKey;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly opts: GoogleClientOptions) {
    this.fetchFn = opts.fetch ?? fetch;
    this.jwks =
      opts.jwks ??
      createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
        timeoutDuration: 5000,
        cooldownDuration: 30_000,
        cacheMaxAge: 3_600_000,
      });
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /** Authorization URL (scopes `openid email profile`, no offline access, PKCE S256). */
  authUrl(p: AuthUrlParams): string {
    const u = new URL(GOOGLE_AUTH_URL);
    const q = u.searchParams;
    q.set('client_id', this.opts.clientId);
    q.set('redirect_uri', p.redirectUri);
    q.set('response_type', 'code');
    q.set('scope', 'openid email profile');
    q.set('code_challenge', pkceChallenge(p.codeVerifier));
    q.set('code_challenge_method', 'S256');
    q.set('state', p.state);
    q.set('nonce', p.nonce);
    if (p.reauth) {
      q.set('prompt', 'login');
      q.set('max_age', '0');
    } else {
      q.set('prompt', 'select_account');
    }
    return u.toString();
  }

  /** Exchange the authorization code and return the raw ID token. */
  async exchangeCode(code: string, codeVerifier: string, redirectUri: string): Promise<string> {
    let res: Response;
    try {
      res = await this.fetchFn(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: codeVerifier,
          redirect_uri: redirectUri,
          client_id: this.opts.clientId,
          client_secret: this.opts.clientSecret,
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: 'error',
      });
    } catch {
      throw new GoogleUnavailableError('token endpoint unreachable');
    }
    if (res.status >= 500 || res.status === 429) {
      throw new GoogleUnavailableError(`token endpoint status ${res.status}`);
    }
    if (!res.ok) throw new GoogleAuthError('oauth_failed', `token endpoint status ${res.status}`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new GoogleAuthError('oauth_failed', 'token endpoint returned invalid JSON');
    }
    const parsed = TokenResponse.safeParse(body);
    if (!parsed.success)
      throw new GoogleAuthError('oauth_failed', 'token response has no id_token');
    return parsed.data.id_token;
  }

  /**
   * Verify an ID token (design §2.2): RS256 signature against Google's JWKS, `iss`, `aud`, `exp`,
   * `iat` within 5 min skew, `nonce` and `email_verified`.
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<GoogleIdentity> {
    let payload;
    try {
      ({ payload } = await jwtVerify(idToken, this.jwks, {
        algorithms: ['RS256'],
        issuer: ISSUERS,
        audience: this.opts.clientId,
        currentDate: new Date(this.now()),
        clockTolerance: CLOCK_SKEW_S,
        requiredClaims: ['exp', 'iat', 'sub'],
      }));
    } catch (err) {
      // A JWKS fetch failure is an availability problem, not a bad token.
      if (err instanceof errors.JWKSTimeout) throw new GoogleUnavailableError('jwks timeout');
      if (err instanceof errors.JOSEError) throw new GoogleAuthError('oauth_failed', err.code);
      throw new GoogleUnavailableError('jwks unavailable');
    }
    const claims = Claims.safeParse(payload);
    if (!claims.success) throw new GoogleAuthError('oauth_failed', 'malformed claims');
    const c = claims.data;
    if (c.iat > Math.floor(this.now() / 1000) + CLOCK_SKEW_S) {
      throw new GoogleAuthError('oauth_failed', 'iat in the future');
    }
    if (!expectedNonce || c.nonce !== expectedNonce) {
      throw new GoogleAuthError('oauth_failed', 'nonce mismatch');
    }
    if (c.email_verified !== true && c.email_verified !== 'true') {
      throw new GoogleAuthError('email_not_verified', 'email not verified');
    }
    if (!c.email) throw new GoogleAuthError('oauth_failed', 'no email claim');
    const name = c.name?.trim();
    return { sub: c.sub, email: c.email, displayName: name ? name.slice(0, 200) : null };
  }
}
