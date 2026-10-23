import { describe, expect, it, vi } from 'vitest';
import { injectObserverIntoOpenTabs } from '../../../lib/site-access/open-tabs';

function setup(tabs: unknown[], executeScript = vi.fn(() => Promise.resolve([]))) {
  const query = vi.fn((_q: unknown) => Promise.resolve(tabs));
  return {
    query,
    executeScript,
    run: (disabledSites: string[] = []) =>
      injectObserverIntoOpenTabs(
        { tabs: { query } as never, scripting: { executeScript } as never },
        { automatic: true, disabledSites },
      ),
  };
}

describe('injectObserverIntoOpenTabs', () => {
  it('queries http(s) tabs and injects only the observer into the top frame of each', async () => {
    const { query, executeScript, run } = setup([
      { id: 1, url: 'https://a.test/' },
      { id: 2, url: 'http://b.test/page' },
    ]);
    expect(await run()).toEqual({ injected: 2, skipped: 0, failed: 0 });
    expect(query).toHaveBeenCalledWith({ url: ['http://*/*', 'https://*/*'] });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 1, frameIds: [0] },
      files: ['/observer.js'],
    });
    expect(executeScript).toHaveBeenCalledWith({
      target: { tabId: 2, frameIds: [0] },
      files: ['/observer.js'],
    });
  });

  it('skips restricted pages, discarded tabs, tabs without an id and disabled sites', async () => {
    const { executeScript, run } = setup([
      { id: 1, url: 'https://chromewebstore.google.com/detail/x' },
      { id: 2, url: 'https://a.test/', discarded: true },
      { url: 'https://a.test/' },
      { id: 4, url: 'https://news.example/story' },
      { id: 5, url: 'https://NEWS.example:8443/other' },
      { id: 6, url: 'https://ok.test/' },
    ]);
    expect(await run(['news.example'])).toEqual({ injected: 1, skipped: 5, failed: 0 });
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({ target: { tabId: 6, frameIds: [0] } }),
    );
  });

  it('matches disabled sites case-insensitively and ignores a trailing dot in the host', async () => {
    const { executeScript, run } = setup([
      { id: 1, url: 'http://localhost.:8080/' },
      { id: 2, url: 'http://LocalHost../' },
      { id: 3, url: 'http://other.test/' },
    ]);
    expect(await run(['localhost'])).toEqual({ injected: 1, skipped: 2, failed: 0 });
    expect(executeScript).toHaveBeenCalledTimes(1);
  });

  it('never targets subframes (executeScript ignores excludeMatches)', async () => {
    const { executeScript, run } = setup([{ id: 1, url: 'https://a.test/' }]);
    await run();
    const target = (executeScript.mock.calls[0] as unknown as [{ target: object }])[0].target;
    expect(target).toEqual({ tabId: 1, frameIds: [0] });
    expect(target).not.toHaveProperty('allFrames');
  });

  it('tolerates tabs that cannot be injected and keeps going', async () => {
    const executeScript = vi
      .fn()
      .mockRejectedValueOnce(new Error('The tab was closed.'))
      .mockResolvedValue([]);
    const { run } = setup(
      [
        { id: 1, url: 'https://a.test/' },
        { id: 2, url: 'https://b.test/' },
        { id: 3, url: 'https://c.test/' },
      ],
      executeScript,
    );
    const result = await run();
    expect(result.injected + result.failed).toBe(3);
    expect(result.failed).toBe(1);
  });

  it('never throws when the tab query fails', async () => {
    const executeScript = vi.fn();
    const result = await injectObserverIntoOpenTabs(
      {
        tabs: { query: () => Promise.reject(new Error('no')) } as never,
        scripting: { executeScript } as never,
      },
      { automatic: true, disabledSites: [] },
    );
    expect(result).toEqual({ injected: 0, skipped: 0, failed: 0 });
    expect(executeScript).not.toHaveBeenCalled();
  });
});
