import type { Config } from '../config';
import type { Database } from '../db/client';
import type { RateLimiter } from '../http/rate-limit';
import { GoogleClient } from './google';
import { AuthService } from './service';
import { AuthStore } from './store';
import { AccessTokens } from './tokens';

/** Everything the auth routes need, built once from validated config. */
export interface AuthRuntime {
  config: Config & {
    publicOrigin: string;
    googleClientId: string;
    googleClientSecret: string;
    tokenSigningSecret: string;
    stateCookieSecret: string;
  };
  store: AuthStore;
  service: AuthService;
  google: GoogleClient;
  limiter: RateLimiter;
  now: () => number;
  https: boolean;
  cookies: { session: string; oauth: string };
}

/** Returns undefined when auth is not fully configured (development without Google credentials). */
export function createAuthRuntime(opts: {
  config: Config;
  db: Database | undefined;
  limiter: RateLimiter;
  now: () => number;
  google?: GoogleClient | undefined;
}): AuthRuntime | undefined {
  const c = opts.config;
  if (
    !opts.db ||
    !c.publicOrigin ||
    !c.googleClientId ||
    !c.googleClientSecret ||
    !c.tokenSigningSecret ||
    !c.stateCookieSecret
  ) {
    return undefined;
  }
  const config = {
    ...c,
    publicOrigin: c.publicOrigin,
    googleClientId: c.googleClientId,
    googleClientSecret: c.googleClientSecret,
    tokenSigningSecret: c.tokenSigningSecret,
    stateCookieSecret: c.stateCookieSecret,
  };
  const google =
    opts.google ??
    new GoogleClient({
      clientId: config.googleClientId,
      clientSecret: config.googleClientSecret,
      now: opts.now,
    });
  const store = new AuthStore(opts.db);
  const tokens = new AccessTokens({
    issuer: config.publicOrigin,
    secret: config.tokenSigningSecret,
    previousSecret: c.tokenSigningSecretPrevious,
    now: opts.now,
  });
  const https = config.publicOrigin.startsWith('https://');
  return {
    config,
    store,
    google,
    limiter: opts.limiter,
    now: opts.now,
    https,
    service: new AuthService({ store, tokens, google, limiter: opts.limiter, now: opts.now }),
    // `__Host-` needs Secure, so plain-http local development uses unprefixed names.
    cookies: https
      ? { session: '__Host-clavis_session', oauth: '__Host-clavis_oauth' }
      : { session: 'clavis_session', oauth: 'clavis_oauth' },
  };
}
