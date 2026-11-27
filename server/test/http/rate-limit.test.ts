import { describe, expect, it } from 'vitest';
import { ApiException } from '../../src/http/errors';
import { RateLimiter, enforce, perHour, perMinute } from '../../src/http/rate-limit';
import { makeClock } from '../auth/harness';

describe('RateLimiter', () => {
  it('allows a burst up to the limit, then reports the wait', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now);
    for (let i = 0; i < 3; i++) expect(l.take('k', perMinute(3))).toBe(0);
    const wait = l.take('k', perMinute(3));
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThanOrEqual(20_000); // 3/min => one token per 20 s
  });

  it('refills over time and keys are independent', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now);
    for (let i = 0; i < 3; i++) l.take('a', perMinute(3));
    expect(l.take('a', perMinute(3))).toBeGreaterThan(0);
    expect(l.take('b', perMinute(3))).toBe(0);
    clock.advance(20_001);
    expect(l.take('a', perMinute(3))).toBe(0);
    expect(l.take('a', perMinute(3))).toBeGreaterThan(0);
  });

  it('never refills beyond the burst size', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now);
    l.take('k', perMinute(2));
    clock.advance(10 * 60_000);
    expect(l.take('k', perMinute(2))).toBe(0);
    expect(l.take('k', perMinute(2))).toBe(0);
    expect(l.take('k', perMinute(2))).toBeGreaterThan(0);
  });

  it('enforce throws RATE_LIMITED with retryAfterMs', () => {
    const l = new RateLimiter(makeClock().now);
    enforce(l, 'k', perMinute(1));
    try {
      enforce(l, 'k', perMinute(1));
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiException);
      expect((e as ApiException).code).toBe('RATE_LIMITED');
      expect((e as ApiException).extra.retryAfterMs).toBeGreaterThan(0);
      expect((e as ApiException).status).toBe(429);
    }
  });

  it('keeps memory bounded', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now, 100);
    for (let i = 0; i < 1000; i++) {
      l.take(`k${i}`, perMinute(5));
      clock.advance(10);
    }
    expect(l.size).toBeLessThanOrEqual(100);
  });

  it('a perHour bucket survives a flood of per-minute keys (each bucket is judged by its own window)', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now, 100);
    for (let i = 0; i < 5; i++) l.take('victim', perHour(5)); // exhausted
    for (let i = 0; i < 1000; i++) {
      l.take(`flood${i}`, perMinute(5));
      clock.advance(100); // 100 s total: still inside the hour bucket's 12 min refill
    }
    expect(l.take('victim', perHour(5))).toBeGreaterThan(0); // still limited, not pruned and reset
  });

  it('an idle bucket is dropped only after its own window has elapsed', () => {
    const clock = makeClock();
    const l = new RateLimiter(clock.now, 2);
    for (let i = 0; i < 5; i++) l.take('h', perHour(5));
    clock.advance(30 * 60_000);
    l.take('a', perHour(5));
    l.take('b', perHour(5)); // over capacity: 'h' is the oldest, but not yet idle for a full hour
    expect(l.size).toBeLessThanOrEqual(2);
  });

  it('take() stays cheap at capacity (amortised O(1) pruning)', () => {
    const l = new RateLimiter(() => 0, 50_000);
    for (let i = 0; i < 50_000; i++) l.take(`k${i}`, perMinute(5));
    const t0 = performance.now();
    for (let i = 50_000; i < 100_000; i++) l.take(`k${i}`, perMinute(5));
    const perOpMs = (performance.now() - t0) / 50_000;
    expect(l.size).toBeLessThanOrEqual(50_000);
    expect(perOpMs).toBeLessThan(0.05); // the old full scan cost ~1 ms per request here
  });
});
