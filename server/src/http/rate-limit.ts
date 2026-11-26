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
 * a shared store. Memory is bounded: when the map grows past `maxKeys`, full (idle) buckets are pruned and,
 * if still too large, the oldest entries are dropped.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 50_000,
  ) {}

  /** Consume one token. Returns 0 when allowed, otherwise the milliseconds until a token is available. */
  take(key: string, rule: RateLimitRule): number {
    const t = this.now();
    const refillPerMs = rule.limit / rule.windowMs;
    const b = this.buckets.get(key) ?? { tokens: rule.limit, updatedAt: t };
    b.tokens = Math.min(rule.limit, b.tokens + (t - b.updatedAt) * refillPerMs);
    b.updatedAt = t;
    let wait = 0;
    if (b.tokens >= 1) b.tokens -= 1;
    else wait = Math.max(1, Math.ceil((1 - b.tokens) / refillPerMs));
    this.buckets.delete(key); // re-insert to keep Map order = recency
    this.buckets.set(key, b);
    if (this.buckets.size > this.maxKeys) this.prune(t, rule);
    return wait;
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(t: number, rule: RateLimitRule): void {
    for (const [k, b] of this.buckets) {
      if (t - b.updatedAt >= rule.windowMs) this.buckets.delete(k);
    }
    for (const k of this.buckets.keys()) {
      if (this.buckets.size <= this.maxKeys) break;
      this.buckets.delete(k);
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

/**
 * Client IP for rate limiting only (never logged). With TRUST_PROXY the proxy-appended (rightmost)
 * X-Forwarded-For entry is used, since earlier entries are client-controlled.
 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff?.split(',').pop()?.trim();
    if (last) return last;
  }
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress ?? 'unknown';
}

/** Middleware limiting per client IP under `name`. */
export function ipRateLimit(
  limiter: RateLimiter,
  name: string,
  rule: RateLimitRule,
  trustProxy: boolean,
): MiddlewareHandler {
  return async (c, next) => {
    enforce(limiter, `ip:${name}:${clientIp(c, trustProxy)}`, rule);
    await next();
  };
}
