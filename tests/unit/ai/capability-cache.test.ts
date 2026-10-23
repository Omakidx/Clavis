import { describe, expect, it, vi } from 'vitest';
import {
  CAPABILITY_STORAGE_KEY,
  CAPABILITY_TTL_MS,
  MAX_CACHED_MODELS,
  createCapabilityCache,
} from '../../../lib/ai';
import { MemoryArea } from '../storage/memory-area';

describe('capability cache', () => {
  it('starts empty and merges observations per model', async () => {
    const cache = createCapabilityCache();
    expect(await cache.get('m')).toEqual({});
    await cache.record('m', { jsonSchema: false });
    await cache.record('m', { reasoningEffort: false });
    expect(await cache.get('m')).toEqual({ jsonSchema: false, reasoningEffort: false });
    expect(await cache.get('other')).toEqual({});
  });

  it('invalidates one model or all of them', async () => {
    const cache = createCapabilityCache();
    await cache.record('a', { jsonSchema: false });
    await cache.record('b', { jsonSchema: true });
    await cache.invalidate('a');
    expect(await cache.get('a')).toEqual({});
    expect(await cache.get('b')).toEqual({ jsonSchema: true });
    await cache.invalidate();
    expect(await cache.get('b')).toEqual({});
  });

  it('forgets a verdict after the TTL so a provider that adds support is noticed', async () => {
    let now = 1_000;
    const cache = createCapabilityCache({ now: () => now });
    await cache.record('m', { jsonSchema: false });
    now += CAPABILITY_TTL_MS;
    expect(await cache.get('m')).toEqual({ jsonSchema: false });
    now += 1;
    expect(await cache.get('m')).toEqual({});
    // A stale verdict is not merged into a fresh observation.
    await cache.record('m', { reasoningEffort: false });
    now += CAPABILITY_TTL_MS + 1;
    await cache.record('m', { jsonSchema: true });
    expect(await cache.get('m')).toEqual({ jsonSchema: true });
  });

  it('bounds the number of remembered models, dropping the least recently written', async () => {
    const cache = createCapabilityCache();
    for (let i = 0; i < MAX_CACHED_MODELS + 5; i++)
      await cache.record(`m${i}`, { jsonSchema: true });
    expect(await cache.get('m0')).toEqual({});
    expect(await cache.get(`m${MAX_CACHED_MODELS + 4}`)).toEqual({ jsonSchema: true });
  });

  describe('persistence (storage.session)', () => {
    it('survives a worker restart: a new cache over the same area sees the verdicts', async () => {
      const area = new MemoryArea();
      const first = createCapabilityCache({ store: area });
      await first.record('m', { jsonSchema: false });
      expect(Object.keys(await area.get(null))).toEqual([CAPABILITY_STORAGE_KEY]);

      const restarted = createCapabilityCache({ store: area });
      expect(await restarted.get('m')).toEqual({ jsonSchema: false });
    });

    it('stores booleans and timestamps only, never text', async () => {
      const area = new MemoryArea();
      await createCapabilityCache({ store: area }).record('m', { jsonSchema: false });
      const stored = JSON.stringify(await area.get(null));
      expect(stored).toMatch(
        /^\{"clavis\.model-capabilities":\{"m":\{"jsonSchema":false,"at":\d+\}\}\}$/,
      );
    });

    it('invalidating removes the stored record', async () => {
      const area = new MemoryArea();
      const cache = createCapabilityCache({ store: area });
      await cache.record('m', { jsonSchema: false });
      await cache.invalidate();
      expect(await area.get(null)).toEqual({});
      expect(await createCapabilityCache({ store: area }).get('m')).toEqual({});
    });

    it('ignores corrupt stored data and survives failing storage', async () => {
      const corrupt = new MemoryArea();
      await corrupt.set({
        [CAPABILITY_STORAGE_KEY]: {
          good: { jsonSchema: false, at: Date.now() },
          bad: 'x',
          worse: { at: 'now' },
        },
      });
      const cache = createCapabilityCache({ store: corrupt });
      expect(await cache.get('good')).toEqual({ jsonSchema: false });
      expect(await cache.get('bad')).toEqual({});
      expect(await cache.get('worse')).toEqual({});

      const broken = {
        get: vi.fn(() => Promise.reject(new Error('boom'))),
        set: vi.fn(() => Promise.reject(new Error('boom'))),
        remove: vi.fn(() => Promise.reject(new Error('boom'))),
      };
      const resilient = createCapabilityCache({ store: broken });
      await expect(resilient.record('m', { jsonSchema: false })).resolves.toBeUndefined();
      expect(await resilient.get('m')).toEqual({ jsonSchema: false });
      await expect(resilient.invalidate()).resolves.toBeUndefined();
    });
  });
});
