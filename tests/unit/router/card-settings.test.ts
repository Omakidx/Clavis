import { describe, expect, it, vi } from 'vitest';
import { EXPLAIN_CARD_SCRIPT_FILE } from '../../../lib/config/constants';
import {
  loadExplainCardResultSchema,
  messageReplySchema,
  openSettingsResultSchema,
} from '../../../lib/contracts';
import { OPEN_SETTINGS_MIN_INTERVAL_MS } from '../../../lib/router/handlers/navigation';
import {
  CARD_MESSAGES,
  ORIGIN,
  RUNTIME_ID,
  contentSender,
  createHarness,
  offscreenSender,
  pageSender,
  popupSender,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST' } };
const load = CARD_MESSAGES['LOAD_EXPLAIN_CARD'];
const openSettings = CARD_MESSAGES['OPEN_SETTINGS'];

const frame = (tabId: number, frameId: number, documentId?: string, url?: string) => ({
  ...contentSender(tabId, url),
  frameId,
  ...(documentId === undefined ? {} : { documentId }),
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<unknown[]>((r) => {
    resolve = () => r([]);
  });
  return { promise, resolve };
};

describe('LOAD_EXPLAIN_CARD', () => {
  it('injects the card script into exactly the sender document (tab and document from the sender)', async () => {
    const h = createHarness();
    const response = await h.call(load, frame(7, 3, 'doc-a'));
    expect(messageReplySchema(loadExplainCardResultSchema).parse(response)).toEqual({
      ok: true,
      data: { loaded: true },
    });
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(1);
    expect(h.injection.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 7, documentIds: ['doc-a'] },
      files: [EXPLAIN_CARD_SCRIPT_FILE],
    });
    // Without a documentId (never on Chrome 147+) it falls back to the frame.
    await h.call(load, frame(7, 3));
    expect(h.injection.scripting.executeScript).toHaveBeenLastCalledWith({
      target: { tabId: 7, frameIds: [3] },
      files: [EXPLAIN_CARD_SCRIPT_FILE],
    });
    expect(EXPLAIN_CARD_SCRIPT_FILE).toBe('content-scripts/explain-card.js');
  });

  it('never targets all frames, and the message cannot choose the target', async () => {
    const h = createHarness();
    await h.call(load, frame(7, 0, 'doc-a'));
    const call = h.injection.scripting.executeScript.mock.calls[0] as unknown as [
      { target: Record<string, unknown> },
    ];
    expect(call[0].target).not.toHaveProperty('allFrames');
    // A target in the message is a shape error, not an instruction.
    for (const extra of [{ tabId: 9 }, { frameId: 2 }, { files: ['x.js'] }, { allFrames: true }]) {
      expect(await h.call({ ...(load as object), ...extra }, frame(7, 0, 'doc-b'))).toMatchObject(
        INVALID,
      );
    }
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('remembers nothing: every request injects again, so a card the page tore down comes back', async () => {
    const h = createHarness();
    for (let i = 0; i < 3; i++) {
      expect(await h.call(load, frame(7, 0, 'doc-a'))).toMatchObject({ ok: true });
    }
    // The card script guards itself; the background must not skip the injection for a document.
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(3);
    await h.call(load, frame(7, 4, 'doc-c'));
    const targets = h.injection.scripting.executeScript.mock.calls.map(
      (c) => (c as unknown as [{ target: unknown }])[0].target,
    );
    expect(targets).toEqual([
      { tabId: 7, documentIds: ['doc-a'] },
      { tabId: 7, documentIds: ['doc-a'] },
      { tabId: 7, documentIds: ['doc-a'] },
      { tabId: 7, documentIds: ['doc-c'] },
    ]);
  });

  it('targets the sender document, never the frame id, when the document is known', async () => {
    const h = createHarness();
    await h.call(load, frame(7, 0, 'doc-old'));
    // The frame navigated: a later request names the NEW document and cannot reach the old one.
    await h.call(load, frame(7, 0, 'doc-new'));
    const targets = h.injection.scripting.executeScript.mock.calls.map(
      (c) => (c as unknown as [{ target: Record<string, unknown> }])[0].target,
    );
    expect(targets.every((t) => !('frameIds' in t) && !('allFrames' in t))).toBe(true);
    expect(targets.map((t) => t['documentIds'])).toEqual([['doc-old'], ['doc-new']]);
  });

  it('shares one injection between concurrent requests for the same frame', async () => {
    const h = createHarness();
    const gate = deferred();
    h.injection.scripting.executeScript.mockReturnValueOnce(gate.promise as never);
    const first = h.call(load, frame(7, 0, 'doc-a'));
    const second = h.call(load, frame(7, 0, 'doc-a'));
    await vi.waitFor(() => expect(h.injection.scripting.executeScript).toHaveBeenCalled());
    gate.resolve();
    expect(await first).toMatchObject({ ok: true });
    expect(await second).toMatchObject({ ok: true });
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('maps injection failures to codes and a failure is not remembered either', async () => {
    const h = createHarness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exec = h.injection.scripting.executeScript;
    exec.mockRejectedValueOnce(
      new Error('Cannot access contents of the page. Extension manifest must request permission'),
    );
    expect(await h.call(load, frame(7, 0, 'doc-a'))).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    exec.mockRejectedValueOnce(new Error('The extensions gallery cannot be scripted.'));
    expect(await h.call(load, frame(7, 0, 'doc-a'))).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_SITE' },
    });
    exec.mockRejectedValueOnce(new Error('secret page text https://x.test/?token=abc'));
    const failed = await h.call(load, frame(7, 0, 'doc-a'));
    expect(failed).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(failed)).not.toContain('secret');
    // None of those was remembered as loaded: the next attempt injects.
    expect(await h.call(load, frame(7, 0, 'doc-a'))).toMatchObject({ ok: true });
    expect(exec).toHaveBeenCalledTimes(4);
  });

  it('respects restricted pages without trying', async () => {
    const h = createHarness();
    const exec = h.injection.scripting.executeScript;
    for (const url of [
      'https://chromewebstore.google.com/detail/x',
      'https://chrome.google.com/webstore/detail/x',
    ]) {
      expect(await h.call(load, frame(7, 0, 'doc-a', url))).toMatchObject({
        ok: false,
        error: { code: 'UNSUPPORTED_SITE' },
      });
    }
    expect(exec).not.toHaveBeenCalled();
    // A same-origin about:blank / srcdoc frame of a web page is injectable.
    expect(await h.call(load, { ...frame(7, 2, 'doc-b'), url: 'about:blank' })).toMatchObject({
      ok: true,
    });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it('answers website content scripts only', async () => {
    const h = createHarness();
    for (const sender of [
      pageSender('/reader.html'),
      pageSender('/practice.html'),
      pageSender('/options.html'),
      pageSender('/onboarding.html'),
      popupSender(),
      offscreenSender(),
      { id: 'ffffffffffffffffffffffffffffffff', url: 'https://example.com/', tab: { id: 1 } },
      {
        id: RUNTIME_ID,
        url: `${ORIGIN}/options.html`,
        frameId: 2,
        tab: { id: 1, url: 'https://e.test/' },
      },
    ]) {
      expect(await h.call(load, sender)).toMatchObject(INVALID);
    }
    expect(h.injection.scripting.executeScript).not.toHaveBeenCalled();
  });
});

describe('OPEN_SETTINGS', () => {
  it('opens the options page, and the named section as an anchor of that same page', async () => {
    const h = createHarness();
    const response = await h.call(openSettings, contentSender());
    expect(messageReplySchema(openSettingsResultSchema).parse(response)).toEqual({
      ok: true,
      data: { opened: true },
    });
    expect(h.browserNav.runtime.openOptionsPage).toHaveBeenCalledTimes(1);
    expect(h.browserNav.tabs.create).not.toHaveBeenCalled();

    for (const [i, [section, anchor]] of [
      ['key', 'section-key'],
      ['model', 'section-model'],
      ['privacy', 'section-privacy'],
      ['voice', 'section-voice'],
    ].entries()) {
      expect(
        await h.call({ v: 1, type: 'OPEN_SETTINGS', section }, contentSender(20 + i)),
      ).toMatchObject({ ok: true });
      expect(h.browserNav.tabs.create).toHaveBeenLastCalledWith({
        url: `${ORIGIN}/options.html#${anchor}`,
      });
    }
  });

  it('rejects unknown sections and extra fields (nothing caller-supplied reaches a url)', async () => {
    const h = createHarness();
    for (const bad of [
      { section: 'site-access' },
      { section: '../popup.html' },
      { section: 'key', url: 'https://evil.example' },
      { section: 5 },
    ]) {
      expect(await h.call({ v: 1, type: 'OPEN_SETTINGS', ...bad }, contentSender())).toMatchObject(
        INVALID,
      );
    }
    expect(h.browserNav.runtime.openOptionsPage).not.toHaveBeenCalled();
    expect(h.browserNav.tabs.create).not.toHaveBeenCalled();
  });

  it('answers content scripts, the reader, the practice page and the popup only', async () => {
    for (const sender of [
      contentSender(),
      pageSender('/reader.html'),
      pageSender('/practice.html'),
      popupSender(),
    ]) {
      const h = createHarness();
      expect(await h.call(openSettings, sender), String(sender.url)).toMatchObject({ ok: true });
    }
    const h = createHarness();
    for (const sender of [
      pageSender('/options.html'),
      pageSender('/onboarding.html'),
      offscreenSender(),
      { id: RUNTIME_ID, url: 'https://example.com/' },
    ]) {
      expect(await h.call(openSettings, sender), String(sender.url)).toMatchObject(INVALID);
    }
    expect(h.browserNav.runtime.openOptionsPage).not.toHaveBeenCalled();
  });

  it('limits one sender to one open per second, without affecting others', async () => {
    let now = 10_000;
    const h = createHarness({ now: () => now });
    expect(await h.call(openSettings, contentSender(5))).toMatchObject({ ok: true });
    now += 400;
    expect(await h.call(openSettings, contentSender(5))).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'RATE_LIMITED', retryAfterMs: 600 }),
    });
    expect(await h.call(openSettings, contentSender(6))).toMatchObject({ ok: true });
    now += OPEN_SETTINGS_MIN_INTERVAL_MS;
    expect(await h.call(openSettings, contentSender(5))).toMatchObject({ ok: true });
    expect(h.browserNav.runtime.openOptionsPage).toHaveBeenCalledTimes(3);
  });

  it('reports a failed open as INTERNAL_ERROR without any text', async () => {
    const h = createHarness();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    h.browserNav.runtime.openOptionsPage.mockRejectedValueOnce(new Error('secret detail'));
    const response = await h.call(openSettings, contentSender());
    expect(response).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(response)).not.toContain('secret');
  });
});
