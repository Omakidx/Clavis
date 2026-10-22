import { hostnameSchema, MAX_DISABLED_SITES } from '../contracts/setup';

export type HostnameCheck =
  { ok: true; host: string } | { ok: false; reason: 'empty' | 'invalid' | 'duplicate' | 'limit' };

/**
 * Turn what a person types or pastes into the lower-case hostname the per-site disable list
 * stores. Accepts `example.com`, `https://www.example.com/page?x=1` and `EXAMPLE.com:8080`;
 * rejects anything that is not a plain host name (IPv6 literals, userinfo, spaces, one-word
 * names without a dot other than `localhost`). IPv4 literals such as 192.168.1.1 are allowed.
 * Internationalized names are stored as punycode.
 */
export function normalizeHostname(raw: string): { ok: true; host: string } | { ok: false } {
  const text = raw.trim();
  if (text === '' || /\s/.test(text)) return { ok: false };
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false };
  if (url.username !== '' || url.password !== '') return { ok: false };
  const host = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!hostnameSchema.safeParse(host).success) return { ok: false };
  if (!host.includes('.') && host !== 'localhost') return { ok: false };
  return { ok: true, host };
}

/** Validate a candidate against the current list. */
export function checkNewSite(raw: string, current: readonly string[]): HostnameCheck {
  if (raw.trim() === '') return { ok: false, reason: 'empty' };
  const normalized = normalizeHostname(raw);
  if (!normalized.ok) return { ok: false, reason: 'invalid' };
  if (current.includes(normalized.host)) return { ok: false, reason: 'duplicate' };
  if (current.length >= MAX_DISABLED_SITES) return { ok: false, reason: 'limit' };
  return normalized;
}
