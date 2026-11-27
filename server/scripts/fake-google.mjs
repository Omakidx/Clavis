// Fake Google OAuth/OIDC server for local development and end-to-end tests. NEVER use in production:
// it signs ID tokens with a key generated in memory and authenticates nobody.
//
//   GET  /authorize  -> 302 redirect_uri?code=..&state=.. immediately (no UI). Identity: `login_hint` (or
//                       `email`) query parameter, optional `name`; default e2e-user-a@example.test.
//   POST /token      -> validates grant, code (single use), redirect_uri, client_id and the PKCE S256 verifier,
//                       returns { id_token, access_token, ... }.
//   GET  /jwks       -> the public key (RS256).
//   GET  /healthz
//
// Run: node scripts/fake-google.mjs   (FAKE_GOOGLE_PORT, default 8788; FAKE_GOOGLE_ISSUER, default its own origin)
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';

const DEFAULT_EMAIL = 'e2e-user-a@example.test';
const CODE_TTL_MS = 5 * 60_000;

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

async function readForm(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) throw new Error('body too large');
    chunks.push(c);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Starts the fake. `port: 0` picks a free port. Returns { url, issuer, close, issuedCodes }.
 * @param {{ port?: number, host?: string, issuer?: string, now?: () => number }} [opts]
 */
export async function startFakeGoogle(opts = {}) {
  const host = opts.host ?? '127.0.0.1';
  const now = opts.now ?? Date.now;
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: 'fake-google-1', alg: 'RS256', use: 'sig' };
  /** @type {Map<string, any>} */
  const codes = new Map();
  let origin = '';

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://fake');
      if (req.method === 'GET' && u.pathname === '/healthz')
        return json(res, 200, { status: 'ok' });
      if (req.method === 'GET' && u.pathname === '/jwks') return json(res, 200, { keys: [jwk] });

      if (req.method === 'GET' && u.pathname === '/authorize') {
        const q = u.searchParams;
        const redirectUri = q.get('redirect_uri');
        const state = q.get('state');
        const challenge = q.get('code_challenge');
        if (!redirectUri || !state || !challenge || q.get('code_challenge_method') !== 'S256') {
          return json(res, 400, { error: 'invalid_request' });
        }
        let target;
        try {
          target = new URL(redirectUri);
        } catch {
          return json(res, 400, { error: 'invalid_request' });
        }
        const email = (q.get('login_hint') ?? q.get('email') ?? DEFAULT_EMAIL).trim().toLowerCase();
        const code = `fake-code-${randomBytes(16).toString('hex')}`;
        codes.set(code, {
          email,
          name: q.get('name') ?? email.split('@')[0],
          nonce: q.get('nonce') ?? undefined,
          challenge,
          redirectUri,
          clientId: q.get('client_id') ?? '',
          authTime: q.get('max_age') === '0' ? Math.floor(now() / 1000) : undefined,
          expires: now() + CODE_TTL_MS,
        });
        target.searchParams.set('code', code);
        target.searchParams.set('state', state);
        res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' });
        return res.end();
      }

      if (req.method === 'POST' && u.pathname === '/token') {
        const f = await readForm(req);
        const spec = codes.get(f.get('code') ?? '');
        codes.delete(f.get('code') ?? ''); // single use, even on failure
        const bad = (why) => json(res, 400, { error: 'invalid_grant', error_description: why });
        if (!spec || spec.expires < now()) return bad('unknown or expired code');
        if (f.get('grant_type') !== 'authorization_code') return bad('grant_type');
        if (f.get('redirect_uri') !== spec.redirectUri) return bad('redirect_uri mismatch');
        if (f.get('client_id') !== spec.clientId) return bad('client_id mismatch');
        const verifier = f.get('code_verifier') ?? '';
        if (createHash('sha256').update(verifier).digest('base64url') !== spec.challenge) {
          return bad('PKCE verifier mismatch');
        }
        const iat = Math.floor(now() / 1000);
        const claims = {
          email: spec.email,
          email_verified: true,
          name: spec.name,
          ...(spec.nonce ? { nonce: spec.nonce } : {}),
          auth_time: spec.authTime ?? iat,
        };
        const idToken = await new SignJWT(claims)
          .setProtectedHeader({ alg: 'RS256', kid: jwk.kid })
          .setIssuer(opts.issuer ?? origin)
          .setAudience(spec.clientId)
          .setSubject(
            `fake-sub-${createHash('sha256').update(spec.email).digest('hex').slice(0, 20)}`,
          )
          .setIssuedAt(iat)
          .setExpirationTime(iat + 3600)
          .sign(privateKey);
        return json(res, 200, {
          id_token: idToken,
          access_token: `fake-access-${randomBytes(8).toString('hex')}`,
          token_type: 'Bearer',
          expires_in: 3599,
        });
      }
      return json(res, 404, { error: 'not_found' });
    } catch {
      return json(res, 500, { error: 'server_error' });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, host, resolve);
  });
  const addr = server.address();
  origin = `http://${host === '::1' ? '[::1]' : host}:${typeof addr === 'object' && addr ? addr.port : opts.port}`;
  return {
    url: origin,
    issuer: opts.issuer ?? origin,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.FAKE_GOOGLE_PORT ?? 8788);
  const host = process.env.FAKE_GOOGLE_HOST ?? '127.0.0.1';
  const opts = { port, host };
  if (process.env.FAKE_GOOGLE_ISSUER) opts.issuer = process.env.FAKE_GOOGLE_ISSUER;
  const fake = await startFakeGoogle(opts);
  console.log(`fake-google listening on ${fake.url} (issuer ${fake.issuer})`);
  console.log(
    `  authorize ${fake.url}/authorize   token ${fake.url}/token   jwks ${fake.url}/jwks`,
  );
  for (const sig of ['SIGINT', 'SIGTERM'])
    process.on(sig, () => void fake.close().then(() => process.exit(0)));
}
