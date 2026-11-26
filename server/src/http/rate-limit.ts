import { isIP } from 'node:net';
import type { Context, MiddlewareHandler } from 'hono';
import { ApiException } from './errors';

export interface RateLimitRule {
  /** Burst size and the number of requests allowed per window. */
  limit: number;
  windowMs: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

/**
 * In-process token buckets (design §5.4). Valid because the service runs ONE replica; scaling out needs
 * a shared store. Buckets are grouped by rule window, each group an insertion-ordered LRU capped at `maxKeys`:
 * a flood of short-window keys can never evict long-window buckets, and expiry is judged by each bucket's own
 * window. Pruning is amortised O(1): only the oldest entries are inspected, and each inspection deletes one.
 */
export class RateLimiter {
  private readonly groups = new Map<number, Map<string, Bucket>>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Consume one token. Returns 0 when allowed, otherwise the milliseconds until a token is available. */
  take(key: string, rule: RateLimitRule): number {
    const t = this.now();
    let group = this.groups.get(rule.windowMs);
    if (!group) this.groups.set(rule.windowMs, (group = new Map()));
    const refillPerMs = rule.limit / rule.windowMs;
    const b = group.get(key) ?? { tokens: rule.limit, updatedAt: t };
    b.tokens = Math.min(rule.limit, b.tokens + (t - b.updatedAt) * refillPerMs);
    b.updatedAt = t;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else wait = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs));
    group.delete(key); // re-insert to keep Map order = recency
    group.set(key, b);
    if (group.size > this.maxKeys) this.evict(group, t, rule.windowMs);
    return wait;
  }

  get size(): number {
    let n = 0;
    for (const g of this.groups.values()) n += g.size;
    return n;
  }

  private evict(group: Map<string, Bucket>, t: number, windowMs: number): void {
    // Oldest first. An entry idle for a full window has refilled completely, so dropping it loses nothing.
    for (const [k, b] of group) {
      if (group.size <= this.maxKeys && t - b.updatedAt < windowMs) break;
      group.delete(k);
    }
  }
}

/** Throw RATE_LIMITED with `retryAfterMs` when `key` is over `rule`. */
export function enforce(limiter: RateLimiter, key: string, rule: RateLimitRule): void {
  const wait = limiter.take(key, rule);
  if (wait > 0) throw new ApiException('RATE_LIMITED', 'Too many requests', { retryAfterMs: wait });
}

export const perMinute = (limit: number): RateLimitRule => ({ limit, windowMs: 60_000 });
export const perHour = (limit: number): RateLimitRule => ({ limit, windowMs: 3_600_000 });

export interface ClientIpSource {
  trustProxy: boolean;
  /** `xff-rightmost`: the Nth-from-right X-Forwarded-For entry (N = hops). `x-real-ip`: that header verbatim. */
  clientIpHeader: 'xff-rightmost' | 'x-real-ip';
  /** Number of trusted proxies that append to X-Forwarded-For. */
  trustedProxyHops: number;
}

/** Canonical key for a client address: IPv4 as is, IPv6 grouped by its /64 prefix (one subscriber, many addresses). */
export function normalizeIp(raw: string): string | undefined {
  let ip = raw.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zone = ip.indexOf('%');
  if (zone >= 0) ip = ip.slice(0, zone);
  const kind = isIP(ip);
  if (kind === 4) return ip;
  if (kind !== 6) return undefined;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped?.[1] && isIP(mapped[1]) === 4) return mapped[1];
  const [head = '', tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return `${groups
    .slice(0, 4)
    .map((g) => parseInt(g, 16).toString(16))
    .join(':')}::/64`;
}

/**
 * Client address for rate limiting only (never logged). Without proxy trust it is the socket peer. With it,
 * only entries appended by our own proxies are believed: client-supplied X-Forwarded-For entries sit to the LEFT of
 * the trusted ones. Anything unparseable falls back to the socket peer.
 */
export function clientIp(c: Context, src: ClientIpSource): string {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const peer = normalizeIp(env?.incoming?.socket?.remoteAddress ?? '') ?? 'unknown';
  if (!src.trustProxy) return peer;
  let candidate: string | undefined;
  if (src.clientIpHeader === 'x-real-ip') {
    candidate = c.req.header('x-real-ip');
  } else {
    const parts = (c.req.header('x-forwarded-for') ?? '').split(',');
    candidate = parts.length >= src.trustedProxyHops ? parts.at(-src.trustedProxyHops) : undefined;
  }
  return (candidate ? normalizeIp(candidate) : undefined) ?? peer;
}

/** Middleware limiting per client IP under `name`. */
export function ipRateLimit(
  limiter: RateLimiter,
  name: string,
  rule: RateLimitRule,
  src: ClientIpSource,
): MiddlewareHandler {
  return async (c, next) => {
    enforce(limiter, `ip:${name}:${clientIp(c, src)}`, rule);
    await next();
  };
}
