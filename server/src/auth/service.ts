import type { TokenPair } from '../../../shared/api-contract';
import { ApiException } from '../http/errors';
import { enforce, perMinute, type RateLimiter } from '../http/rate-limit';
import { FamilyCache } from './family-cache';
import { GoogleAuthError, GoogleUnavailableError, type GoogleClient } from './google';
import type { AuthStore, IssuedRefresh, UserRow } from './store';
import type { AccessTokens } from './tokens';

export const toUser = (u: UserRow) => ({
  id: u.id,
  email: u.email,
  displayName: u.displayName,
  createdAt: u.createdAt.getTime(),
});

export interface AuthServiceDeps {
  store: AuthStore;
  tokens: AccessTokens;
  google: GoogleClient;
  limiter: RateLimiter;
  now: () => number;
}

/** Translate Google failures into API errors. */
export function mapGoogleError(err: unknown): never {
  if (err instanceof GoogleAuthError) {
    if (err.kind === 'email_not_verified') {
      throw new ApiException('EMAIL_NOT_VERIFIED', 'The Google account email is not verified');
    }
    throw new ApiException('OAUTH_FAILED', 'Google sign-in could not be completed');
  }
  if (err instanceof GoogleUnavailableError) {
    throw new ApiException('UNAVAILABLE', 'Google is temporarily unavailable', {
      retryAfterMs: 5000,
    });
  }
  throw err;
}

export class AuthService {
  private readonly families: FamilyCache;

  constructor(private readonly d: AuthServiceDeps) {
    this.families = new FamilyCache(d.now);
  }

  private async pair(user: UserRow, refresh: IssuedRefresh): Promise<TokenPair> {
    const access = await this.d.tokens.issue({ userId: user.id, familyId: refresh.familyId });
    return {
      accessToken: access.token,
      accessTokenExpiresAt: access.expiresAt,
      refreshToken: refresh.token,
      refreshTokenExpiresAt: refresh.expiresAt.getTime(),
      user: toUser(user),
    };
  }

  /** §2.2 steps 6.3-6.6: exchange, verify, upsert, new family. */
  async signInWithGoogle(code: string, codeVerifier: string, redirectUri: string, nonce: string) {
    try {
      const idToken = await this.d.google.exchangeCode(code, codeVerifier, redirectUri);
      const identity = await this.d.google.verifyIdToken(idToken, nonce);
      const now = new Date(this.d.now());
      const user = await this.d.store.upsertGoogleUser(identity, now);
      return this.pair(user, await this.d.store.createFamily(user.id, now));
    } catch (err) {
      return mapGoogleError(err);
    }
  }

  async refresh(presented: string): Promise<TokenPair> {
    const familyId = await this.d.store.findFamily(presented);
    if (familyId) enforce(this.d.limiter, `fam:refresh:${familyId}`, perMinute(10));
    const r = await this.d.store.rotateRefresh(presented, new Date(this.d.now()));
    switch (r.kind) {
      case 'ok':
        return this.pair(r.user, r.refresh);
      case 'revoked':
      case 'reuse_revoked':
        this.families.evict(r.familyId);
        throw new ApiException('SESSION_REVOKED', 'Session was revoked');
      case 'reuse_race':
        throw new ApiException('TOKEN_REUSED', 'Refresh token was already used');
      case 'expired':
      case 'invalid':
        throw new ApiException('UNAUTHENTICATED', 'Refresh token is invalid or expired');
    }
  }

  /** Unknown tokens are a silent no-op so the endpoint cannot be used to probe for valid tokens. */
  async logout(presented: string): Promise<void> {
    const familyId = await this.d.store.revokeFamilyByToken(presented, new Date(this.d.now()));
    if (familyId) this.families.evict(familyId);
  }

  async logoutAll(userId: string): Promise<void> {
    const families = await this.d.store.revokeAllForUser(userId, new Date(this.d.now()));
    for (const f of families) this.families.evict(f);
  }

  /** Verify a Bearer access token and that its family is not revoked (cached <= 30 s). */
  async authenticateBearer(token: string): Promise<{ userId: string; familyId: string }> {
    const v = await this.d.tokens.verify(token);
    if (!v.ok) {
      if (v.reason === 'expired') throw new ApiException('TOKEN_EXPIRED', 'Access token expired');
      throw new ApiException('UNAUTHENTICATED', 'Invalid access token');
    }
    let active = this.families.get(v.claims.familyId);
    if (active === undefined) {
      const gen = this.families.begin();
      active = await this.d.store.isFamilyActive(v.claims.familyId);
      this.families.set(v.claims.familyId, active, gen);
    }
    if (!active) throw new ApiException('SESSION_REVOKED', 'Session was revoked');
    return v.claims;
  }
}
