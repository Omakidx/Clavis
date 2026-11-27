/**
 * Everything about pointing the extension at a local API and a fake Google (dev servers and
 * CLAVIS_FORCE_FEATURES test builds). This module is only ever CALLED behind the compile-time
 * switch `OVERRIDES_ALLOWED` (lib/account/config.ts), so a store build's bundler drops it, and a
 * store bundle contains no localhost, login_hint or override value.
 */
import type { AccountConfig } from './config';

export interface DevEnv {
  WXT_CLAVIS_API_ORIGIN?: string | undefined;
  WXT_CLAVIS_GOOGLE_AUTH_URL?: string | undefined;
  WXT_CLAVIS_GOOGLE_LOGIN_HINT?: string | undefined;
}

/** A plain function (not a top-level Set): an unused one is dropped from a store bundle. */
export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

/** Adds the fake-Google `login_hint` to an authorize URL. Called only behind `OVERRIDES_ALLOWED`. */
export function withLoginHint(url: string, hint: string | undefined): string {
  if (hint === undefined) return url;
  const next = new URL(url);
  next.searchParams.set('login_hint', hint);
  return next.toString();
}

function parse(raw: string | undefined): URL | null {
  if (raw === undefined || raw.trim() === '') return null;
  try {
    const url = new URL(raw.trim());
    return url.username === '' && url.password === '' ? url : null;
  } catch {
    return null;
  }
}

/** https anywhere, http only to the local machine. */
export function devOrigin(raw: string | undefined): string | null {
  const url = parse(raw);
  if (url === null) return null;
  if (url.protocol === 'https:') return url.origin;
  return url.protocol === 'http:' && isLocalHost(url.hostname) ? url.origin : null;
}

function devAuthUrl(raw: string | undefined): string | null {
  const url = parse(raw);
  if (url === null) return null;
  return url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname))
    ? url.origin + url.pathname
    : null;
}

/** The overrides present in `env`, applied over `base`. */
export function applyDevOverrides(base: AccountConfig, env: DevEnv): AccountConfig {
  const hint = env.WXT_CLAVIS_GOOGLE_LOGIN_HINT ?? '';
  return {
    ...base,
    apiOrigin: devOrigin(env.WXT_CLAVIS_API_ORIGIN) ?? base.apiOrigin,
    googleAuthUrl: devAuthUrl(env.WXT_CLAVIS_GOOGLE_AUTH_URL) ?? base.googleAuthUrl,
    googleLoginHint: /^[^\s@&#?]{1,64}@[^\s@&#?]{1,128}$/.test(hint) ? hint : undefined,
  };
}
