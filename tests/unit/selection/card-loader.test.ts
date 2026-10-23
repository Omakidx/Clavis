import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadedExplainCard, loadExplainCard } from '../../../lib/selection/card-loader';
import { EXPLAIN_CARD_GLOBAL, type ExplainCardApi } from '../../../lib/selection/ui-api';

const world = globalThis as Record<symbol, ExplainCardApi | undefined>;
const fakeCard = (): ExplainCardApi => ({
  present: () => Promise.resolve(),
  dismiss: () => undefined,
  destroy: () => undefined,
});

beforeEach(() => {
  delete world[EXPLAIN_CARD_GLOBAL];
});
afterEach(() => {
  delete world[EXPLAIN_CARD_GLOBAL];
});

const messageKey = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => 'resolved',
    (error: { messageKey?: string }) => error.messageKey,
  );

describe('loading the explanation card on the first Explain', () => {
  it('does not ask the background when the card is already registered in this frame', async () => {
    const card = fakeCard();
    world[EXPLAIN_CARD_GLOBAL] = card;
    const send = vi.fn();
    expect(await loadExplainCard({ send })).toBe(card);
    expect(send).not.toHaveBeenCalled();
    expect(loadedExplainCard()).toBe(card);
  });

  it('sends LOAD_EXPLAIN_CARD once and waits for the card to register', async () => {
    const card = fakeCard();
    const send = vi.fn().mockImplementation(() => {
      // The background injects the script; it registers itself a moment later.
      setTimeout(() => (world[EXPLAIN_CARD_GLOBAL] = card), 30);
      return Promise.resolve({ ok: true, data: { loaded: true } });
    });
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
    const [a, b] = await Promise.all([
      loadExplainCard({ send, wait }),
      loadExplainCard({ send, wait }),
    ]);
    expect(a).toBe(card);
    expect(b).toBe(card);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'LOAD_EXPLAIN_CARD' });
  });

  it('rejects with a specific toolbar message when the background refuses', async () => {
    const send = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'INTERNAL_ERROR', message: '' } });
    expect(await messageKey(loadExplainCard({ send }))).toBe('cardLoadFailed');
  });

  it('rejects when nobody answers or the send throws', async () => {
    expect(await messageKey(loadExplainCard({ send: () => Promise.resolve(undefined) }))).toBe(
      'cardLoadFailed',
    );
    expect(
      await messageKey(loadExplainCard({ send: () => Promise.reject(new Error('no receiver')) })),
    ).toBe('cardLoadFailed');
  });

  it('rejects when the script runs but never registers, instead of waiting forever', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, data: { loaded: true } });
    const wait = () => Promise.resolve();
    expect(await messageKey(loadExplainCard({ send, wait, registerTimeoutMs: 100 }))).toBe(
      'cardLoadFailed',
    );
  });

  it('can load again after a failure (the next Explain retries)', async () => {
    const failing = vi.fn().mockResolvedValue(undefined);
    await messageKey(loadExplainCard({ send: failing }));
    const card = fakeCard();
    const send = vi.fn().mockImplementation(() => {
      world[EXPLAIN_CARD_GLOBAL] = card;
      return Promise.resolve({ ok: true, data: { loaded: true } });
    });
    expect(await loadExplainCard({ send })).toBe(card);
  });
});
