import {
  CLAVIS_API_ORIGIN_DEFAULT,
  ENDPOINT_OVERRIDES,
  GOOGLE_AUTHORIZE_URL,
} from '../config/constants';
import { applyDevOverrides, type DevEnv } from './dev-config';

/**
 * Where sign-in and sync go (docs/clavis-sync-design.md 2.1, 7.1). Build-time configuration:
 * - `WXT_CLAVIS_GOOGLE_CLIENT_ID`: the public Web-application client id. Empty = "not configured".
 * - `WXT_CLAVIS_API_ORIGIN`: the API origin, read only where overrides are allowed; a store build
 *   always uses the production default.
 * - Dev/test builds only (`OVERRIDES_ALLOWED`): a local `http:` API origin, an authorize URL for a
 *   fake Google (`WXT_CLAVIS_GOOGLE_AUTH_URL`) and a `login_hint` (`WXT_CLAVIS_GOOGLE_LOGIN_HINT`).
 *   Those values are read only inside the compile-time branch in `buildAccountConfig`, so a store
 *   bundle contains none of them (scripts/check-store-overrides.mjs verifies it).
 */
export interface AccountConfig {
  apiOrigin: string;
  googleClientId: string;
  googleAuthUrl: string;
  /** Dev/test builds only: `login_hint` for a fake Google that picks the user from it. */
  googleLoginHint: string | undefined;
}

/** True only in a dev-server build or a CLAVIS_FORCE_FEATURES test build. A compile-time constant. */
export const OVERRIDES_ALLOWED: boolean = ENDPOINT_OVERRIDES || import.meta.env.DEV === true;

export interface AccountEnv extends DevEnv {
  WXT_CLAVIS_GOOGLE_CLIENT_ID?: string | undefined;
}

/** An `https:` origin, or null. */
export function httpsOrigin(raw: string | undefined): string | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

/** The store configuration for `env`: production defaults, an `https:` origin, the client id. */
export function storeAccountConfig(
  env: AccountEnv,
  defaults: { apiOrigin: string; googleAuthUrl: string } = {
    apiOrigin: CLAVIS_API_ORIGIN_DEFAULT,
    googleAuthUrl: GOOGLE_AUTHORIZE_URL,
  },
): AccountConfig {
  return {
    apiOrigin: httpsOrigin(env.WXT_CLAVIS_API_ORIGIN) ?? defaults.apiOrigin,
    googleClientId: (env.WXT_CLAVIS_GOOGLE_CLIENT_ID ?? '').trim(),
    googleAuthUrl: defaults.googleAuthUrl,
    googleLoginHint: undefined,
  };
}

/**
 * Pure, for tests: the configuration for `env`, with the dev overrides when `allowOverrides`.
 * The extension itself never calls this (it would keep the override code in a store bundle).
 */
export function resolveAccountConfig(
  env: AccountEnv,
  allowOverrides: boolean,
  defaults?: { apiOrigin: string; googleAuthUrl: string },
): AccountConfig {
  const base = storeAccountConfig(env, defaults);
  return allowOverrides ? applyDevOverrides(base, env) : base;
}

/**
 * The configuration of this build. Only STATIC `import.meta.env.X` reads (a whole-object read
 * would inline every WXT_ variable), and the dev ones only inside the dead-code-eliminated branch.
 */
export function buildAccountConfig(): AccountConfig {
  const base = storeAccountConfig({
    WXT_CLAVIS_GOOGLE_CLIENT_ID: import.meta.env.WXT_CLAVIS_GOOGLE_CLIENT_ID as string | undefined,
  });
  if (OVERRIDES_ALLOWED) {
    return applyDevOverrides(base, {
      WXT_CLAVIS_API_ORIGIN: import.meta.env.WXT_CLAVIS_API_ORIGIN as string | undefined,
      WXT_CLAVIS_GOOGLE_AUTH_URL: import.meta.env.WXT_CLAVIS_GOOGLE_AUTH_URL as string | undefined,
      WXT_CLAVIS_GOOGLE_LOGIN_HINT: import.meta.env.WXT_CLAVIS_GOOGLE_LOGIN_HINT as
        string | undefined,
    });
  }
  return base;
}
