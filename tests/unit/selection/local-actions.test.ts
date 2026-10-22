import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createLocalActions } from '../../../lib/selection/local-actions';
import type { RunContext } from '../../../lib/selection/ui-api';

const context = (signal: AbortSignal = new AbortController().signal): RunContext => ({
  snapshot: { selectionId: 'x', source: 'webpage', kind: 'word', text: 'bank' },
  overLimit: false,
  signal,
});

describe('local actions (Phase 4 controller)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('only implements listen and explain, as a pause that then resolves', async () => {
    const actions = createLocalActions(500);
    expect(Object.keys(actions).sort()).toEqual(['explain', 'listen']);
    let done = false;
    void (actions.listen?.(context()) as Promise<void>).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(499);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
  });

  it('ends early, without waiting, when the run is aborted', async () => {
    const control = new AbortController();
    let done = false;
    void (createLocalActions(500).explain?.(context(control.signal)) as Promise<void>).then(
      () => (done = true),
    );
    control.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('sends nothing: no runtime message, no fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    void createLocalActions(10).explain?.(context());
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
