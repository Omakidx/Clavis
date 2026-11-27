import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

export const b64url = (buf: Uint8Array): string => Buffer.from(buf).toString('base64url');

/** `bytes` random bytes as base64url. */
export function randomToken(bytes = 32): string {
  return b64url(randomBytes(bytes));
}

export function sha256(data: string | Uint8Array): Buffer {
  return createHash('sha256').update(data).digest();
}

/** Constant-time string comparison that does not leak length through an early return. */
export function safeEqual(a: string, b: string): boolean {
  const ha = sha256(a);
  const hb = sha256(b);
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/** PKCE S256 challenge: BASE64URL(SHA256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return b64url(sha256(verifier));
}

function deriveKey(secretB64: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(secretB64, 'base64'), '', info, 32));
}

const SEAL_INFO = 'clavis-state-cookie-v1';

/** AES-256-GCM seal of a JSON-serialisable value. Output: base64url(iv | ciphertext | tag). */
export function seal(secretB64: string, value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretB64, SEAL_INFO), iv);
  cipher.setAAD(Buffer.from(SEAL_INFO));
  const ct = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return b64url(Buffer.concat([iv, ct, cipher.getAuthTag()]));
}

/** Inverse of {@link seal}. Returns undefined for any tampering, truncation or wrong key. */
export function unseal(secretB64: string, sealed: string): unknown {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    if (raw.length < 12 + 16 + 1) return undefined;
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(raw.length - 16);
    const ct = raw.subarray(12, raw.length - 16);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretB64, SEAL_INFO), iv);
    decipher.setAAD(Buffer.from(SEAL_INFO));
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(pt.toString('utf8'));
  } catch {
    return undefined;
  }
}
