import { createHash } from 'node:crypto';
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWK } from 'jose';
import { Writable } from 'node:stream';
import { createApp } from '../../src/app';
import { GoogleClient, GOOGLE_TOKEN_URL } from '../../src/auth/google';
import { loadConfig, type Config } from '../../src/config';
import type { DbHandle } from '../../src/db/client';
import { RateLimiter } from '../../src/http/rate-limit';
import { createLogger } from '../../src/logger';

export const ORIGIN = 'https://clavis-api-production.up.railway.app';
export const DEV_EXT_ID = 'ebfpdncfkebjagolnbmfdhikaipiflbl';
export const STORE_EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const OTHER_EXT_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
export const CLIENT_ID = 'test-client.apps.googleusercontent.com';
export const CLIENT_SECRET = 'test-client-secret-value';
export const EXT_ORIGIN = `chrome-extension://${DEV_EXT_ID}`;
export const EXT_REDIRECT = `https://${DEV_EXT_ID}.chromiumapp.org/`;

export const SIGNING_SECRET = Buffer.alloc(32, 1).toString('base64');
export const SIGNING_SECRET_2 = Buffer.alloc(32, 2).toString('base64');
export const STATE_SECRET = Buffer.alloc(32, 3).toString('base64');

export function testEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    NODE_ENV: 'test',
    PUBLIC_ORIGIN: ORIGIN,
    GOOGLE_CLIENT_ID: CLIENT_ID,
    GOOGLE_CLIENT_SECRET: CLIENT_SECRET,
    ALLOWED_EXTENSION_IDS: `${DEV_EXT_ID},${STORE_EXT_ID}`,
    TOKEN_SIGNING_SECRET: SIGNING_SECRET,
    STATE_COOKIE_SECRET: STATE_SECRET,
    ...extra,
  };
}

export const verifier = (n = 1) => `v${n}`.padEnd(43, 'x');
export const challengeOf = (v: string) => createHash('sha256').update(v).digest('base64url');

export interface CodeSpec {
  sub?: string;
  email?: string;
  name?: string;
  nonce: string;
  codeChallenge: string;
  redirectUri: string;
  email_verified?: boolean | string | undefined;
  aud?: string;
  iss?: string;
  expOffsetS?: number;
  iatOffsetS?: number;
  /** Sign with a key that is not in the JWKS. */
  wrongKey?: boolean;
  omitEmail?: boolean;
  /** Make the token endpoint answer this status instead. */
  tokenStatus?: number;
}

export interface MockGoogle {
  client: GoogleClient;
  /** Register a code the mock token endpoint will accept once. */
  issueCode(spec: CodeSpec): string;
  tokenRequests: URLSearchParams[];
  /** Make the JWKS lookup fail (network). */
  breakJwks(): void;
  failFetch(): void;
}

export async function createMockGoogle(now: () => number): Promise<MockGoogle> {
  const good = await generateKeyPair('RS256', { extractable: true });
  const bad = await generateKeyPair('RS256', { extractable: true });
  const jwk: JWK = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const local = createLocalJWKSet({ keys: [jwk] });
  let jwksBroken = false;
  let fetchBroken = false;
  const codes = new Map<string, CodeSpec>();
  const tokenRequests: URLSearchParams[] = [];
  let n = 0;

  const mockFetch: typeof fetch = async (input, init) => {
    if (fetchBroken) throw new TypeError('network down');
    if (String(input) !== GOOGLE_TOKEN_URL) throw new Error(`unexpected fetch ${String(input)}`);
    const form = new URLSearchParams(String(init?.body));
    tokenRequests.push(form);
    const spec = codes.get(form.get('code') ?? '');
    const bad400 = () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
    if (!spec) return bad400();
    codes.delete(form.get('code') ?? ''); // single use
    if (spec.tokenStatus) return new Response('{}', { status: spec.tokenStatus });
    if (
      form.get('client_id') !== CLIENT_ID ||
      form.get('client_secret') !== CLIENT_SECRET ||
      form.get('grant_type') !== 'authorization_code' ||
      form.get('redirect_uri') !== spec.redirectUri ||
      challengeOf(form.get('code_verifier') ?? '') !== spec.codeChallenge
    ) {
      return bad400();
    }
    const nowS = Math.floor(now() / 1000);
    const claims: Record<string, unknown> = {
      sub: spec.sub ?? 'google-sub-1',
      name: spec.name ?? 'Ada Lovelace',
      nonce: spec.nonce,
      email_verified: 'email_verified' in spec ? spec.email_verified : true,
    };
    if (!spec.omitEmail) claims['email'] = spec.email ?? 'ada@example.test';
    const jwt = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(spec.iss ?? 'https://accounts.google.com')
      .setAudience(spec.aud ?? CLIENT_ID)
      .setIssuedAt(nowS + (spec.iatOffsetS ?? 0))
      .setExpirationTime(nowS + (spec.expOffsetS ?? 3600))
      .sign(spec.wrongKey ? bad.privateKey : good.privateKey);
    return new Response(
      JSON.stringify({ id_token: jwt, access_token: 'g-access', expires_in: 3599 }),
    );
  };

  const client = new GoogleClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    fetch: mockFetch,
    jwks: (async (h, t) => {
      if (jwksBroken) throw new TypeError('jwks down');
      return local(h, t);
    }) as typeof local,
    now,
  });
  return {
    client,
    tokenRequests,
    issueCode(spec) {
      const code = `code-${++n}`;
      codes.set(code, spec);
      return code;
    },
    breakJwks: () => {
      jwksBroken = true;
    },
    failFetch: () => {
      fetchBroken = true;
    },
  };
}

export interface Clock {
  t: number;
  now: () => number;
  advance(ms: number): void;
}
export function makeClock(start = Date.parse('2026-11-26T12:00:00Z')): Clock {
  const c: Clock = { t: start, now: () => c.t, advance: (ms) => void (c.t += ms) };
  return c;
}

export interface Harness {
  app: ReturnType<typeof createApp>;
  config: Config;
  clock: Clock;
  google: MockGoogle;
  limiter: RateLimiter;
  logs: string[];
}

export async function createHarness(
  opts: { db?: DbHandle | undefined; env?: Record<string, string> | undefined } = {},
): Promise<Harness> {
  const clock = makeClock();
  const google = await createMockGoogle(clock.now);
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _enc, cb) {
      logs.push(chunk.toString());
      cb();
    },
  });
  const limiter = new RateLimiter(clock.now);
  const config = loadConfig(testEnv(opts.env));
  const app = createApp({
    config,
    logger: createLogger('info', sink),
    db: opts.db,
    now: clock.now,
    google: google.client,
    limiter,
  });
  return { app, config, clock, google, limiter, logs };
}

/** POST JSON helper. */
export function postJson(
  h: Harness,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return h.app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

export interface Pair {
  accessToken: string;
  accessTokenExpiresAt: number;
  refreshToken: string;
  refreshTokenExpiresAt: number;
  user: { id: string; email: string; displayName: string | null; createdAt: number };
}

/** Extension sign-in through the mocked Google. */
export async function extSignIn(
  h: Harness,
  who: { sub?: string; email?: string; email_verified?: boolean } = {},
  n = 1,
): Promise<Pair> {
  const res = await extSignInRaw(h, who, n);
  if (res.status !== 200) throw new Error(`sign-in failed: ${res.status}`);
  return (await res.json()) as Pair;
}

export async function extSignInRaw(
  h: Harness,
  who: { sub?: string; email?: string; email_verified?: boolean } = {},
  n = 1,
  over: { nonce?: string; redirectUri?: string; origin?: string } = {},
) {
  const nonce = `nonce-${n}`;
  const code = h.google.issueCode({
    ...who,
    nonce,
    codeChallenge: challengeOf(verifier(n)),
    redirectUri: EXT_REDIRECT,
  });
  return postJson(
    h,
    '/v1/auth/extension/google',
    {
      code,
      codeVerifier: verifier(n),
      redirectUri: over.redirectUri ?? EXT_REDIRECT,
      nonce: over.nonce ?? nonce,
    },
    { origin: over.origin ?? EXT_ORIGIN },
  );
}

export const bearer = (p: Pair | string) => ({
  authorization: `Bearer ${typeof p === 'string' ? p : p.accessToken}`,
});

/** Parse Set-Cookie headers into name -> {value, attrs}. */
export function cookiesOf(res: Response): Record<string, { value: string; attrs: string }> {
  const out: Record<string, { value: string; attrs: string }> = {};
  for (const line of res.headers.getSetCookie()) {
    const [pair = '', ...rest] = line.split(';');
    const i = pair.indexOf('=');
    out[pair.slice(0, i)] = { value: pair.slice(i + 1), attrs: rest.join(';').trim() };
  }
  return out;
}

export interface WebLogin {
  session: string;
  csrf: string;
  cookie: string;
  res: Response;
}

/** Full dashboard flow: start -> (mock Google) -> callback. */
export async function webLogin(
  h: Harness,
  who: { sub?: string; email?: string; email_verified?: boolean } = {},
  opts: { reauth?: boolean; cookie?: string } = {},
): Promise<WebLogin> {
  const start = await h.app.request(`/auth/google/start${opts.reauth ? '?reauth=1' : ''}`);
  const loc = new URL(start.headers.get('location') as string);
  const oauth = cookiesOf(start)['__Host-clavis_oauth']?.value as string;
  const code = h.google.issueCode({
    ...who,
    nonce: loc.searchParams.get('nonce') as string,
    codeChallenge: loc.searchParams.get('code_challenge') as string,
    redirectUri: `${ORIGIN}/auth/google/callback`,
  });
  const cookie = [`__Host-clavis_oauth=${oauth}`, opts.cookie].filter(Boolean).join('; ');
  const res = await h.app.request(
    `/auth/google/callback?code=${code}&state=${loc.searchParams.get('state')}`,
    { headers: { cookie } },
  );
  const session = cookiesOf(res)['__Host-clavis_session']?.value ?? '';
  let csrf = '';
  if (session) {
    const s = await h.app.request('/v1/session', {
      headers: { cookie: `__Host-clavis_session=${session}` },
    });
    csrf = ((await s.json()) as { csrfToken: string }).csrfToken;
  }
  return { session, csrf, cookie: `__Host-clavis_session=${session}`, res };
}

/** Non-GET request carrying every CSRF credential. */
export function webPost(h: Harness, path: string, w: WebLogin, extra: Record<string, string> = {}) {
  return h.app.request(path, {
    method: 'POST',
    headers: { cookie: w.cookie, origin: ORIGIN, 'x-csrf-token': w.csrf, ...extra },
  });
}
