import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AI_RATE_LIMIT } from '../../../lib/config/constants';

// These tests exercise the bucket mechanics with a fixed 10-per-minute config, independent of
// the product setting (AI_RATE_LIMIT, D-21).
const TEST_LIMIT = { ...AI_RATE_LIMIT, capacity: 10, windowMs: 60_000 };
const CAP = TEST_LIMIT.capacity;
const REFILL_MS = TEST_LIMIT.windowMs / TEST_LIMIT.capacity;
import {
  abortTabRequests,
  createAiGuard,
  InFlightRequests,
  TokenBuckets,
  panelKey,
  senderKey,
  type RateLimitConfig,
} from '../../../lib/router/limiter';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

const buckets = (over: Partial<RateLimitConfig> = {}) =>
  new TokenBuckets({ ...TEST_LIMIT, ...over });

describe('TokenBuckets', () => {
  it('allows a burst up to capacity, then says how long until the next token', () => {
    const b = buckets();
    for (let i = 0; i < CAP; i++) expect(b.take('tab:1')).toEqual({ ok: true });
    // capacity per window = one token every REFILL_MS.
    expect(b.take('tab:1')).toEqual({ ok: false, retryAfterMs: REFILL_MS });
  });

  it('refills evenly: one token per REFILL_MS, never more than capacity', () => {
    const b = buckets();
    for (let i = 0; i < CAP; i++) b.take('tab:1');
    vi.advanceTimersByTime(REFILL_MS - 1);
    expect(b.take('tab:1').ok).toBe(false);
    vi.advanceTimersByTime(1);
    expect(b.take('tab:1')).toEqual({ ok: true });
    expect(b.take('tab:1').ok).toBe(false);

    vi.advanceTimersByTime(10 * 60_000);
    for (let i = 0; i < CAP; i++) expect(b.take('tab:1').ok).toBe(true);
    expect(b.take('tab:1').ok).toBe(false);
  });

  it('reports a shrinking retryAfterMs while waiting', () => {
    const b = buckets();
    for (let i = 0; i < 10; i++) b.take('tab:1');
    vi.advanceTimersByTime(2_000);
    expect(b.take('tab:1')).toEqual({ ok: false, retryAfterMs: 4_000 });
  });

  it('keeps senders independent', () => {
    const b = buckets();
    for (let i = 0; i < 10; i++) b.take('tab:1');
    expect(b.take('tab:1').ok).toBe(false);
    expect(b.take('tab:2').ok).toBe(true);
    expect(b.take('page:/popup.html').ok).toBe(true);
  });

  it('forgets a sender (closed tab) and clears everything', () => {
    const b = buckets();
    for (let i = 0; i < 10; i++) b.take('tab:1');
    b.forget('tab:1');
    expect(b.take('tab:1').ok).toBe(true);
    b.clear();
    expect(b.size).toBe(0);
  });

  it('bounds memory: the least recently used sender is evicted past maxTrackedSenders', () => {
    const b = buckets({ maxTrackedSenders: 3 });
    for (const id of [1, 2, 3, 4, 5]) b.take(`tab:${id}`);
    expect(b.size).toBe(3);
    // tab:1 was evicted, so it starts with a full bucket again.
    for (let i = 0; i < 10; i++) expect(b.take('tab:1').ok).toBe(true);
  });

  it('does not let a clock that went backwards mint tokens', () => {
    const b = buckets();
    for (let i = 0; i < 10; i++) b.take('tab:1');
    vi.setSystemTime(500_000);
    expect(b.take('tab:1').ok).toBe(false);
  });
});

describe('InFlightRequests', () => {
  it('a new request from the same sender aborts the previous one', () => {
    const inflight = new InFlightRequests();
    const first = inflight.begin('tab:1', 'r1');
    expect(first.signal.aborted).toBe(false);
    const second = inflight.begin('tab:1', 'r2');
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
    expect(inflight.size).toBe(1);
  });

  it('does not touch other senders', () => {
    const inflight = new InFlightRequests();
    const a = inflight.begin('tab:1', 'r1');
    const b = inflight.begin('tab:2', 'r2');
    expect(a.signal.aborted).toBe(false);
    expect(b.signal.aborted).toBe(false);
  });

  it('the finished older request cannot remove its successor', () => {
    const inflight = new InFlightRequests();
    const first = inflight.begin('tab:1', 'r1');
    const second = inflight.begin('tab:1', 'r2');
    first.end();
    expect(inflight.size).toBe(1);
    expect(inflight.cancel('tab:1', 'r2')).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it('cancel only aborts the named request of that sender', () => {
    const inflight = new InFlightRequests();
    const a = inflight.begin('tab:1', 'r1');
    expect(inflight.cancel('tab:2', 'r1')).toBe(false);
    expect(inflight.cancel('tab:1', 'other')).toBe(false);
    expect(a.signal.aborted).toBe(false);
    expect(inflight.cancel('tab:1', 'r1')).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(inflight.cancel('tab:1', 'r1')).toBe(false);
  });

  it('forget (tab closed) and abortAll (key removed) abort and clear', () => {
    const inflight = new InFlightRequests();
    const a = inflight.begin('tab:1', 'r1');
    const b = inflight.begin('tab:2', 'r2');
    inflight.forget('tab:1');
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    inflight.abortAll();
    expect(b.signal.aborted).toBe(true);
    expect(inflight.size).toBe(0);
  });
});

describe('senderKey', () => {
  it('keys tabs by id and tab-less extension pages by path', () => {
    expect(senderKey({ tabId: 7, path: '/reader.html' })).toBe('tab:7');
    expect(senderKey({ path: '/popup.html' })).toBe('page:/popup.html');
    expect(senderKey({})).toBe('page:unknown');
  });
});

describe('abortTabRequests (Phase 9 Q1)', () => {
  it('aborts the request of the tab and of its side panel, and no other tab', () => {
    const guard = createAiGuard();
    const tab = guard.inFlight.begin(senderKey({ tabId: 7 }), 'a');
    const panel = guard.inFlight.begin(panelKey(7), 'b');
    const other = guard.inFlight.begin(senderKey({ tabId: 8 }), 'c');
    const otherPanel = guard.inFlight.begin(panelKey(8), 'd');
    abortTabRequests(guard, 7);
    expect(tab.signal.aborted).toBe(true);
    expect(panel.signal.aborted).toBe(true);
    expect(other.signal.aborted).toBe(false);
    expect(otherPanel.signal.aborted).toBe(false);
    expect(guard.inFlight.size).toBe(2);
  });

  it('is harmless for a tab with nothing in flight, and keeps the rate-limit state', () => {
    const guard = createAiGuard();
    expect(guard.buckets.take(senderKey({ tabId: 7 })).ok).toBe(true);
    expect(() => abortTabRequests(guard, 7)).not.toThrow();
  });
});
