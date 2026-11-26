import { SignJWT, jwtVerify, errors } from 'jose';
import { randomToken, sha256 } from './crypto';

export const ACCESS_TOKEN_TTL_S = 15 * 60;
export const ACCESS_AUDIENCE = 'clavis-ext';
export const REFRESH_PREFIX = 'crt_';
export const REFRESH_SLIDING_MS = 30 * 24 * 3600 * 1000;
export const REFRESH_ABSOLUTE_MS = 180 * 24 * 3600 * 1000;
/** A used refresh token presented again within this window is a retry race, not theft. */
export const REUSE_GRACE_MS = 60_000;

export interface AccessClaims {
  userId: string;
  familyId: string;
}

export type AccessVerdict =
  { ok: true; claims: AccessClaims } | { ok: false; reason: 'expired' | 'invalid' };

const key = (secretB64: string) => Buffer.from(secretB64, 'base64');

export class AccessTokens {
  constructor(
    private readonly opts: {
      issuer: string;
      secret: string;
      previousSecret?: string | undefined;
      now: () => number;
    },
  ) {}

  /** HS256 JWT `{ iss, aud:'clavis-ext', sub:userId, fam:familyId, iat, exp }` signed with the current secret. */
  async issue(claims: AccessClaims): Promise<{ token: string; expiresAt: number }> {
    const iat = Math.floor(this.opts.now() / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_S;
    const token = await new SignJWT({ fam: claims.familyId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setIssuer(this.opts.issuer)
      .setAudience(ACCESS_AUDIENCE)
      .setSubject(claims.userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key(this.opts.secret));
    return { token, expiresAt: exp * 1000 };
  }

  /** Verify with the current secret, then the previous one (rotation window). Only HS256 is accepted. */
  async verify(token: string): Promise<AccessVerdict> {
    const secrets = [this.opts.secret, this.opts.previousSecret].filter((s): s is string => !!s);
    let expired = false;
    for (const s of secrets) {
      try {
        const { payload } = await jwtVerify(token, key(s), {
          algorithms: ['HS256'],
          issuer: this.opts.issuer,
          audience: ACCESS_AUDIENCE,
          currentDate: new Date(this.opts.now()),
          clockTolerance: 0,
        });
        const fam = payload['fam'];
        if (typeof payload.sub !== 'string' || typeof fam !== 'string') {
          return { ok: false, reason: 'invalid' };
        }
        return { ok: true, claims: { userId: payload.sub, familyId: fam } };
      } catch (err) {
        if (err instanceof errors.JWTExpired) expired = true;
      }
    }
    return { ok: false, reason: expired ? 'expired' : 'invalid' };
  }
}

export function newRefreshToken(): string {
  return REFRESH_PREFIX + randomToken(32);
}

export function hashRefreshToken(token: string): Buffer {
  return sha256(token);
}
