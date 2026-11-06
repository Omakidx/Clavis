import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadToolbar } from '../../../lib/selection/toolbar-loader';
import { TOOLBAR_GLOBAL, type ToolbarLoader } from '../../../lib/selection/ui-api';

const world = globalThis as Record<symbol, ToolbarLoader | undefined>;
afterEach(() => {
  delete world[TOOLBAR_GLOBAL];
});

describe('on-demand toolbar loading', () => {
  it('does not inject or construct UI until requested, then reuses the registered factory', async () => {
    const factory = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockImplementation(() => {
      world[TOOLBAR_GLOBAL] = factory;
      return Promise.resolve({ ok: true, data: { loaded: true } });
    });
    expect(send).not.toHaveBeenCalled();
    const options = { actions: {} };
    await loadToolbar(options, { send });
    await loadToolbar(options, { send });
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'LOAD_TOOLBAR' });
    expect(factory).toHaveBeenNthCalledWith(1, options);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('deduplicates concurrent injection but creates a distinct handle for each controller', async () => {
    const factory = vi.fn().mockImplementation(() => Promise.resolve({}));
    const send = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      world[TOOLBAR_GLOBAL] = factory;
      return { ok: true };
    });
    const [first, second] = await Promise.all([
      loadToolbar({}, { send }),
      loadToolbar({}, { send }),
    ]);
    expect(send).toHaveBeenCalledOnce();
    expect(first).not.toBe(second);
  });

  it('rejects denied, missing, or failed registration replies, and retries the next selection', async () => {
    for (const send of [
      vi.fn().mockResolvedValue(undefined),
      vi.fn().mockResolvedValue({ ok: false }),
      vi.fn().mockResolvedValue({ ok: true }),
      vi.fn().mockRejectedValue(new Error('Runtime unavailable')),
    ]) {
      await expect(loadToolbar({}, { send })).rejects.toBeInstanceOf(Error);
    }
    const factory = vi.fn().mockResolvedValue({});
    const send = vi.fn().mockImplementation(() => {
      world[TOOLBAR_GLOBAL] = factory;
      return Promise.resolve({ ok: true });
    });
    await loadToolbar({}, { send });
    expect(factory).toHaveBeenCalledOnce();
  });
});
