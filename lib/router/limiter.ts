import { AI_RATE_LIMIT, EXTENSION_PAGES } from '../config/constants';
import { panelTabOf } from './sender';

/**
 * Per-sender AI request limits (Phase 2 security review, HIGH-1 follow-up): a token
 * bucket for the rate, plus at most one in-flight AI_EXPLAIN.
 *
 * In-flight policy: a NEW request from the same sender ABORTS the previous one.
 * Architecture §5/§6: a new selection invalidates the old one and a stale result must
 * never render, so cancelling the old request (and replying REQUEST_CANCELLED to its
 * now-irrelevant caller) matches the product, saves tokens, and cannot be used to queue up
 * parallel billable calls. Rejecting the NEW request instead would leave the user staring
 * at a stale card after changing the selection.
 *
 * State is in memory. A worker restart resets it, but it also drops every in-flight
 * request, so the limits can be exceeded only across a restart (accepted; documented).
 */

export interface RateLimitConfig {
  capacity: number;
  windowMs: number;
  maxTrackedSenders: number;
}

export type RateDecision = { ok: true } | { ok: false; retryAfterMs: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly refillPerMs: number;

  constructor(
    private readonly config: RateLimitConfig = AI_RATE_LIMIT,
    private readonly now: () => number = Date.now,
  ) {
    this.refillPerMs = config.capacity / config.windowMs;
  }

  /** Spend one token for `key`, or say how long until one is available. */
  take(key: string): RateDecision {
    const at = this.now();
    const bucket = this.buckets.get(key) ?? { tokens: this.config.capacity, updatedAt: at };
    const elapsed = Math.max(0, at - bucket.updatedAt);
    bucket.tokens = Math.min(this.config.capacity, bucket.tokens + elapsed * this.refillPerMs);
    bucket.updatedAt = at;

    if (bucket.tokens < 1) {
      this.buckets.set(key, bucket);
      // The epsilon keeps floating-point noise (4000.0000001) from rounding up a whole millisecond.
      const wait = (1 - bucket.tokens) / this.refillPerMs;
      return { ok: false, retryAfterMs: Math.max(1, Math.ceil(wait - 1e-6)) };
    }
    bucket.tokens -= 1;
    // Re-insert so the Map's iteration order is least-recently-used first.
    this.buckets.delete(key);
    this.buckets.set(key, bucket);
    this.evict();
    return { ok: true };
  }

  forget(key: string): void {
    this.buckets.delete(key);
  }

  clear(): void {
    this.buckets.clear();
  }

  get size(): number {
    return this.buckets.size;
  }

  private evict(): void {
    while (this.buckets.size > this.config.maxTrackedSenders) {
      const oldest = this.buckets.keys().next();
      if (oldest.done) return;
      this.buckets.delete(oldest.value);
    }
  }
}

interface InFlight {
  requestId: string;
  controller: AbortController;
}

/** At most one in-flight AI request per sender; a newer one aborts the older. */
export class InFlightRequests {
  private readonly active = new Map<string, InFlight>();

  /** Register a request, aborting this sender's previous one. */
  begin(key: string, requestId: string): { signal: AbortSignal; end(): void } {
    this.active.get(key)?.controller.abort();
    const entry: InFlight = { requestId, controller: new AbortController() };
    this.active.set(key, entry);
    return {
      signal: entry.controller.signal,
      end: () => {
        // Only remove our own entry: a newer request may already have replaced it.
        if (this.active.get(key) === entry) this.active.delete(key);
      },
    };
  }

  /** AI_CANCEL: abort the sender's request if it is the one named. */
  cancel(key: string, requestId: string): boolean {
    const entry = this.active.get(key);
    if (entry === undefined || entry.requestId !== requestId) return false;
    entry.controller.abort();
    this.active.delete(key);
    return true;
  }

  /** The sender went away (tab closed): abort and forget. */
  forget(key: string): void {
    this.active.get(key)?.controller.abort();
    this.active.delete(key);
  }

  /** The key was removed or all data was cleared: no request may keep running with it. */
  abortAll(): void {
    for (const entry of this.active.values()) entry.controller.abort();
    this.active.clear();
  }

  get size(): number {
    return this.active.size;
  }
}

export interface AiGuard {
  buckets: TokenBuckets;
  inFlight: InFlightRequests;
}

export function createAiGuard(now: () => number = Date.now): AiGuard {
  return { buckets: new TokenBuckets(AI_RATE_LIMIT, now), inFlight: new InFlightRequests() };
}

/**
 * The limiter key for a sender: its tab, or its page for tab-less extension pages. A side panel
 * is tab-less but belongs to one tab (the query of its own url), so its key is per tab too: panels
 * in two windows never cancel each other's request.
 */
export function senderKey(sender: { tabId?: number; path?: string; url?: string }): string {
  if (sender.tabId !== undefined) return `tab:${sender.tabId}`;
  if (sender.path === EXTENSION_PAGES.sidepanel) {
    const tab = panelTabOf(sender.url);
    if (tab !== undefined) return panelKey(tab);
  }
  return `page:${sender.path ?? 'unknown'}`;
}

/** The limiter key of the side panel that belongs to `tabId` (forgotten when the tab closes). */
export const panelKey = (tabId: number): string => `panel:${tabId}`;
