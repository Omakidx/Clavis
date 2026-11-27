/**
 * OAuth authorization code + PKCE (S256), state and nonce for the extension sign-in
 * (docs/clavis-sync-design.md 2.2). Web Crypto only; nothing here touches storage.
 */

export interface PkceSecrets {
  codeVerifier: string;
  codeChallenge: string;
  state: string;
  nonce: string;
}

export interface Random {
  getRandomValues<T extends ArrayBufferView>(array: T): T;
}

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes: number, random: Random): string {
  return base64url(random.getRandomValues(new Uint8Array(bytes)));
}

/** `BASE64URL(SHA256(verifier))`. */
export async function challengeOf(verifier: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/** 32-byte verifier (43 chars), 16-byte state and nonce. Held in memory for one sign-in only. */
export async function createPkceSecrets(random: Random = globalThis.crypto): Promise<PkceSecrets> {
  const codeVerifier = randomToken(32, random);
  return {
    codeVerifier,
    codeChallenge: await challengeOf(codeVerifier),
    state: randomToken(16, random),
    nonce: randomToken(16, random),
  };
}

export interface AuthorizeInput {
  authUrl: string;
  clientId: string;
  redirectUri: string;
  secrets: PkceSecrets;
}

/** The Google authorize URL: `openid email profile`, no offline access (design 2.1). */
export function buildAuthorizeUrl(input: AuthorizeInput): string {
  const url = new URL(input.authUrl);
  const params = url.searchParams;
  params.set('client_id', input.clientId);
  params.set('redirect_uri', input.redirectUri);
  params.set('response_type', 'code');
  params.set('scope', 'openid email profile');
  params.set('code_challenge', input.secrets.codeChallenge);
  params.set('code_challenge_method', 'S256');
  params.set('state', input.secrets.state);
  params.set('nonce', input.secrets.nonce);
  params.set('prompt', 'select_account');
  return url.toString();
}

export type CallbackResult =
  { ok: true; code: string } | { ok: false; reason: 'cancelled' | 'failed' };

/**
 * Read the redirect Google sent back. The state must match exactly, there must be exactly one
 * `code`, and the URL must be the redirect URI we asked for. `access_denied` is the user saying no.
 */
export function parseCallback(
  returned: string | undefined,
  redirectUri: string,
  expectedState: string,
): CallbackResult {
  if (returned === undefined || returned === '') return { ok: false, reason: 'cancelled' };
  let url: URL;
  let expected: URL;
  try {
    url = new URL(returned);
    expected = new URL(redirectUri);
  } catch {
    return { ok: false, reason: 'failed' };
  }
  if (url.origin !== expected.origin || url.pathname !== expected.pathname) {
    return { ok: false, reason: 'failed' };
  }
  const params = url.searchParams;
  const states = params.getAll('state');
  // Never act on an answer that is not ours, even an error one.
  if (states.length !== 1 || states[0] !== expectedState) return { ok: false, reason: 'failed' };
  const error = params.get('error');
  if (error !== null) {
    return { ok: false, reason: error === 'access_denied' ? 'cancelled' : 'failed' };
  }
  const codes = params.getAll('code');
  if (codes.length !== 1 || codes[0] === undefined || codes[0] === '') {
    return { ok: false, reason: 'failed' };
  }
  return { ok: true, code: codes[0] };
}
