import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '../../../lib/config/constants';
import { mayAcknowledgeDisclosure } from '../../../lib/router/handlers/ai';
import {
  MAX_HANDOFF_TABS,
  OPEN_SIDE_PANEL_MIN_INTERVAL_MS,
  sidePanelPath,
} from '../../../lib/router/handlers/sidepanel';
import { senderKey } from '../../../lib/router/limiter';
import { classifySender, panelTabOf } from '../../../lib/router/sender';
import {
  HANDOFF,
  ORIGIN,
  REQ_A,
  REQ_B,
  RUNTIME_ID,
  SETTINGS_MESSAGES,
  KEY_MESSAGES,
  CARD_MESSAGES,
  contentSender,
  createHarness,
  explainMessage,
  makeReady,
  openSidePanelMessage,
  pageSender,
  panelSender,
  popupSender,
  sidePanelStateMessage,
  type Harness,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST', message: expect.any(String) } };

describe('classifySender: the side panel', () => {
  const identity = { runtimeId: RUNTIME_ID, extensionOrigin: `${ORIGIN}/` };
  const classify = (sender: object) => classifySender(sender, identity);

  it('is recognised by exact path, without a tab (like the popup), keeping its query for the tab', () => {
    const sender = classify(panelSender(7));
    expect(sender).toMatchObject({ kind: 'extension', path: '/sidepanel.html' });
    expect(sender.tabId).toBeUndefined();
    expect(panelTabOf(sender.url)).toBe(7);
  });

  it('is never a frame, never inside a website and never another path', () => {
    expect(classify({ ...panelSender(), frameId: 3 }).kind).toBe('unknown');
    expect(classify({ ...panelSender(), frameId: 0 }).kind).toBe('extension');
    expect(
      classify({
        ...panelSender(),
        frameId: 2,
        tab: { id: 4, url: 'https://evil.example/' },
      }).kind,
    ).toBe('unknown');
    expect(classify({ id: RUNTIME_ID, url: `${ORIGIN}/sidepanel.html.evil?tab=1` }).kind).toBe(
      'unknown',
    );
    expect(classify({ id: RUNTIME_ID, url: `${ORIGIN}/sidepanel/index.html` }).kind).toBe(
      'unknown',
    );
  });

  it('reads the panel tab only from a plain number', () => {
    expect(panelTabOf(`${ORIGIN}/sidepanel.html?tab=12`)).toBe(12);
    for (const url of [
      undefined,
      'nope',
      `${ORIGIN}/sidepanel.html`,
      `${ORIGIN}/sidepanel.html?tab=`,
      `${ORIGIN}/sidepanel.html?tab=-1`,
      `${ORIGIN}/sidepanel.html?tab=1e3`,
      `${ORIGIN}/sidepanel.html?tab=99999999999`,
      `${ORIGIN}/sidepanel.html?tab=1.5`,
    ]) {
      expect(panelTabOf(url), String(url)).toBeUndefined();
    }
    expect(sidePanelPath(9)).toBe('sidepanel.html?tab=9');
  });

  it('gets its own limiter key per tab', () => {
    expect(senderKey({ path: '/sidepanel.html', url: `${ORIGIN}/sidepanel.html?tab=3` })).toBe(
      'panel:3',
    );
    expect(senderKey({ path: '/sidepanel.html' })).toBe('page:/sidepanel.html');
    expect(senderKey({ tabId: 3 })).toBe('tab:3');
  });
});

describe('OPEN_SIDE_PANEL', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });

  it("prepares and opens the panel for the SENDER's tab, in the same synchronous turn", () => {
    // No await between the message and the calls: Chrome keeps the user gesture only through the
    // message event's own task (docs/decisions/p8-sidepanel-spike.md), so open() must not wait.
    const { claimed } = h.send(openSidePanelMessage(), contentSender(11));
    expect(claimed).toBe(true);
    expect(h.sidePanelApi.setOptions).toHaveBeenCalledTimes(1);
    expect(h.sidePanelApi.setOptions).toHaveBeenCalledWith({
      tabId: 11,
      path: 'sidepanel.html?tab=11',
      enabled: true,
    });
    expect(h.sidePanelApi.open).toHaveBeenCalledTimes(1);
    expect(h.sidePanelApi.open).toHaveBeenCalledWith({ tabId: 11 });
    const order = [
      h.sidePanelApi.setOptions.mock.invocationCallOrder[0]!,
      h.sidePanelApi.open.mock.invocationCallOrder[0]!,
    ];
    expect(order[0]).toBeLessThan(order[1]!);
  });

  it('replies opened and tells an open panel to refresh', async () => {
    expect(await h.call(openSidePanelMessage(), contentSender(11))).toEqual({
      ok: true,
      data: { opened: true },
    });
    expect(h.notify).toHaveBeenCalledWith({
      v: 1,
      type: 'SIDE_PANEL_UPDATED',
      tabId: 11,
      revision: expect.any(Number),
    });
    // The broadcast carries no text at all.
    expect(JSON.stringify(h.notify.mock.calls)).not.toContain('break the ice');
  });

  it('takes the tab from the browser-provided sender, never from the message', async () => {
    const forged = { ...openSidePanelMessage(), tabId: 99 };
    expect(await h.call(forged, contentSender(11))).toMatchObject(INVALID);
    expect(h.sidePanelApi.open).not.toHaveBeenCalled();
    await h.call(openSidePanelMessage(), contentSender(11));
    expect(h.sidePanelApi.open).toHaveBeenCalledWith({ tabId: 11 });
  });

  it('allows web page content scripts, the reader and the practice page, nobody else', async () => {
    for (const sender of [
      contentSender(2),
      pageSender('/reader.html'),
      pageSender('/practice.html'),
    ]) {
      const fresh = createHarness();
      expect(await fresh.call(openSidePanelMessage(), sender), String(sender.url)).toMatchObject({
        ok: true,
      });
    }
    for (const sender of [
      popupSender(),
      pageSender('/options.html'),
      pageSender('/onboarding.html'),
      panelSender(),
      { id: RUNTIME_ID, url: `${ORIGIN}/unlisted.html`, frameId: 0, tab: { id: 3 } },
      { id: 'someone-else', url: 'https://example.com/', frameId: 0, tab: { id: 3 } },
    ]) {
      const fresh = createHarness();
      expect(
        await fresh.call(openSidePanelMessage(), sender),
        JSON.stringify(sender),
      ).toMatchObject(INVALID);
      expect(fresh.sidePanelApi.open).not.toHaveBeenCalled();
      expect(fresh.sidePanel.size).toBe(0);
    }
  });

  it('accepts a message above the normal size bound, and still bounds it', async () => {
    const big = openSidePanelMessage({
      ...HANDOFF,
      snapshot: { ...HANDOFF.snapshot, text: 'x'.repeat(2000) },
      results: [
        {
          ...HANDOFF.results[0]!,
          summary: 'ä'.repeat(600),
          contextualMeaning: '字'.repeat(800),
          definition: '字'.repeat(600),
          examples: [{ sentence: '字'.repeat(300) }, { sentence: '字'.repeat(300) }],
          caveat: '字'.repeat(400),
        },
        {
          ...HANDOFF.results[0]!,
          mode: 'simplify',
          simplifiedText: '字'.repeat(4000),
        },
        {
          ...HANDOFF.results[0]!,
          mode: 'translate',
          translation: { language: 'French', text: '字'.repeat(4000), literal: '字'.repeat(4000) },
        },
      ],
    });
    const bytes = new TextEncoder().encode(JSON.stringify(big)).length;
    expect(bytes).toBeGreaterThan(LIMITS.maxMessageBytes);
    expect(await h.call(big, contentSender())).toMatchObject({ ok: true });
    // And above its own bound, nothing is parsed.
    const huge = openSidePanelMessage({ ...HANDOFF, pad: 'y'.repeat(LIMITS.maxHandoffBytes) });
    expect(await h.call(huge, contentSender())).toMatchObject(INVALID);
  });

  it('rejects a malformed hand-off without touching Chrome or memory', async () => {
    for (const bad of [
      { ...HANDOFF, results: [] },
      { ...HANDOFF, snapshot: { ...HANDOFF.snapshot, text: '' } },
      { ...HANDOFF, extra: true },
      { snapshot: HANDOFF.snapshot },
    ]) {
      expect(await h.call(openSidePanelMessage(bad), contentSender())).toMatchObject(INVALID);
    }
    expect(h.sidePanelApi.setOptions).not.toHaveBeenCalled();
    expect(h.sidePanelApi.open).not.toHaveBeenCalled();
    expect(h.sidePanel.size).toBe(0);
  });

  it('forgets the hand-off when Chrome refuses to open the panel, and says so without detail', async () => {
    h.sidePanelApi.open.mockImplementationOnce(() =>
      Promise.reject(
        new Error('`sidePanel.open()` may only be called in response to a user gesture.'),
      ),
    );
    const reply = await h.call(openSidePanelMessage(), contentSender(4));
    expect(reply).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(reply)).not.toContain('gesture');
    expect(h.sidePanel.size).toBe(0);
    expect(h.notify).not.toHaveBeenCalled();
  });

  it('does not leave the panel enabled when it never opened, and keeps an earlier hand-off when a later one fails', async () => {
    h.sidePanelApi.open.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    await h.call(openSidePanelMessage(), contentSender(4));
    expect(h.sidePanelApi.setOptions).toHaveBeenLastCalledWith({
      tabId: 4,
      path: 'sidepanel.html?tab=4',
      enabled: false,
    });
    // A tab that had a working panel keeps its explanation (and its panel) when a later try fails.
    let now = 10_000;
    const kept = createHarness({ now: () => (now += 1_000) });
    await kept.call(openSidePanelMessage(), contentSender(6));
    kept.sidePanelApi.open.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    await kept.call(
      openSidePanelMessage({ ...HANDOFF, snapshot: { ...HANDOFF.snapshot, text: 'second' } }),
      contentSender(6),
    );
    const state = (await kept.call(sidePanelStateMessage(6), panelSender(6))) as {
      data: { handoff: { snapshot: { text: string } } | null };
    };
    expect(state.data.handoff?.snapshot.text).toBe('break the ice');
    expect(kept.sidePanelApi.setOptions).not.toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('keeps throttling refused opens (a refusal does not reset the 300 ms limit)', async () => {
    let now = 1_000;
    const t = createHarness({ now: () => now });
    t.sidePanelApi.open.mockImplementation(() => Promise.reject(new Error('no gesture')));
    expect(await t.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    now += 100;
    expect(await t.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    expect(t.sidePanelApi.open).toHaveBeenCalledTimes(1);
  });

  it('a refused open from a 25th tab evicts nobody; a successful one evicts the oldest', async () => {
    let now = 0;
    const t = createHarness({ now: () => (now += 1_000) });
    for (let tab = 1; tab <= MAX_HANDOFF_TABS; tab++) {
      await t.call(openSidePanelMessage(), contentSender(tab));
    }
    expect(t.sidePanel.size).toBe(MAX_HANDOFF_TABS);
    t.sidePanelApi.open.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    await t.call(openSidePanelMessage(), contentSender(25));
    expect(t.sidePanel.size).toBe(MAX_HANDOFF_TABS);
    for (const tab of [1, MAX_HANDOFF_TABS]) {
      const state = (await t.call(sidePanelStateMessage(tab), panelSender(tab))) as {
        data: { handoff: unknown };
      };
      expect(state.data.handoff, `tab ${tab}`).not.toBeNull();
    }
    const refused = (await t.call(sidePanelStateMessage(25), panelSender(25))) as {
      data: { handoff: unknown };
    };
    expect(refused.data.handoff).toBeNull();
    await t.call(openSidePanelMessage(), contentSender(26));
    expect(t.sidePanel.size).toBe(MAX_HANDOFF_TABS);
    const evicted = (await t.call(sidePanelStateMessage(1), panelSender(1))) as {
      data: { handoff: unknown };
    };
    expect(evicted.data.handoff).toBeNull();
  });

  it('a refused open leaves an already enabled panel enabled', async () => {
    let now = 0;
    const t = createHarness({ now: () => (now += 1_000) });
    await t.call(openSidePanelMessage(), contentSender(4));
    t.sidePanel.reset(4);
    t.sidePanelApi.open.mockImplementationOnce(() => Promise.reject(new Error('no gesture')));
    await t.call(openSidePanelMessage(), contentSender(4));
    expect(t.sidePanelApi.setOptions).not.toHaveBeenCalledWith(
      expect.objectContaining({ enabled: false }),
    );
  });

  it('also copes with a throwing sidePanel API', async () => {
    h.sidePanelApi.setOptions.mockImplementationOnce(() => {
      throw new Error('no such API');
    });
    expect(await h.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    });
    expect(h.sidePanel.size).toBe(0);
  });

  it('limits how often one tab can open the panel', async () => {
    let now = 1_000;
    const limited = createHarness({ now: () => now });
    expect(await limited.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: true,
    });
    expect(await limited.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: false,
      error: { code: 'RATE_LIMITED', retryAfterMs: OPEN_SIDE_PANEL_MIN_INTERVAL_MS },
    });
    // Another tab is not affected; the first one is free again after the interval.
    expect(await limited.call(openSidePanelMessage(), contentSender(5))).toMatchObject({
      ok: true,
    });
    now += OPEN_SIDE_PANEL_MIN_INTERVAL_MS;
    expect(await limited.call(openSidePanelMessage(), contentSender(4))).toMatchObject({
      ok: true,
    });
    expect(limited.sidePanelApi.open).toHaveBeenCalledTimes(3);
  });

  it('keeps at most MAX_HANDOFF_TABS tabs, oldest first', async () => {
    let now = 0;
    const many = createHarness({ now: () => (now += 1_000) });
    for (let tab = 1; tab <= MAX_HANDOFF_TABS + 3; tab++) {
      await many.call(openSidePanelMessage(), contentSender(tab));
    }
    expect(many.sidePanel.size).toBe(MAX_HANDOFF_TABS);
    const first = (await many.call(sidePanelStateMessage(1), panelSender(1))) as {
      data: { handoff: unknown };
    };
    expect(first.data.handoff).toBeNull();
    const last = (await many.call(
      sidePanelStateMessage(MAX_HANDOFF_TABS + 3),
      panelSender(MAX_HANDOFF_TABS + 3),
    )) as { data: { handoff: unknown } };
    expect(last.data.handoff).not.toBeNull();
  });
});

describe('GET_SIDE_PANEL_STATE', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await h.call(openSidePanelMessage(), contentSender(5));
  });

  it('gives a panel the hand-off of ITS tab, and nothing of another tab', async () => {
    const own = (await h.call(sidePanelStateMessage(5), panelSender(5))) as {
      ok: boolean;
      data: { revision: number; handoff: { snapshot: { text: string } } | null };
    };
    expect(own.ok).toBe(true);
    expect(own.data.handoff?.snapshot.text).toBe('break the ice');
    // The panel of tab 6 has nothing, and cannot ask for tab 5's.
    const other = (await h.call(sidePanelStateMessage(6), panelSender(6))) as {
      data: { handoff: unknown };
    };
    expect(other.data.handoff).toBeNull();
    expect(await h.call(sidePanelStateMessage(5), panelSender(6))).toMatchObject(INVALID);
    // A panel without its tab in its url (opened by hand in a tab) gets nothing either.
    expect(
      await h.call(sidePanelStateMessage(5), {
        id: RUNTIME_ID,
        url: `${ORIGIN}/sidepanel.html`,
        frameId: 0,
        tab: { id: 5, url: `${ORIGIN}/sidepanel.html` },
      }),
    ).toMatchObject(INVALID);
  });

  it('is the side panel only', async () => {
    for (const sender of [
      contentSender(5),
      popupSender(),
      pageSender('/reader.html'),
      pageSender('/practice.html'),
      pageSender('/options.html'),
      pageSender('/onboarding.html'),
    ]) {
      expect(await h.call(sidePanelStateMessage(5), sender), String(sender.url)).toMatchObject(
        INVALID,
      );
    }
  });

  it('changes its revision with every hand-off and every drop', async () => {
    const revision = async () =>
      ((await h.call(sidePanelStateMessage(5), panelSender(5))) as { data: { revision: number } })
        .data.revision;
    const first = await revision();
    let now = Date.now();
    const later = createHarness({ now: () => (now += 5_000) });
    await later.call(openSidePanelMessage(), contentSender(5));
    const a = (
      (await later.call(sidePanelStateMessage(5), panelSender(5))) as {
        data: { revision: number };
      }
    ).data.revision;
    await later.call(openSidePanelMessage(), contentSender(5));
    const b = (
      (await later.call(sidePanelStateMessage(5), panelSender(5))) as {
        data: { revision: number };
      }
    ).data.revision;
    expect(b).toBeGreaterThan(a);
    expect(first).toBeGreaterThan(0);
  });

  it('forgets a tab that closed or started loading another page, and tells the panel', async () => {
    h.notify.mockClear();
    h.sidePanel.reset(5);
    expect(h.sidePanel.size).toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.sidePanel.reset(5); // nothing held: nothing to tell
    expect(h.notify).toHaveBeenCalledTimes(1);

    await h.call(openSidePanelMessage(), pageSender('/reader.html', 8));
    expect(h.sidePanel.size).toBe(1);
    h.sidePanel.forget(8);
    expect(h.sidePanel.size).toBe(0);
  });

  it('is cleared with all data (FR-078)', async () => {
    await h.call(openSidePanelMessage(), contentSender(6));
    expect(h.sidePanel.size).toBe(2);
    h.notify.mockClear();
    await h.call(KEY_MESSAGES['CLEAR_ALL_DATA'], pageSender('/options.html'));
    expect(h.sidePanel.size).toBe(0);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });
});

describe('what the side panel may call', () => {
  let h: Harness;
  beforeEach(async () => {
    h = createHarness();
    await makeReady(h);
  });

  it('may use the explain, speech and settings routes it needs, per its own tab', async () => {
    const panel = panelSender(5);
    expect(await h.call(explainMessage(REQ_A, { mode: 'etymology' }), panel)).toMatchObject({
      ok: true,
    });
    expect(h.provider.explain).toHaveBeenCalledTimes(1);
    expect(
      await h.call({ v: 1, type: 'TTS_SPEAK', requestId: REQ_B, text: 'bank', rate: 1 }, panel),
    ).toMatchObject({ ok: true });
    expect(await h.call({ v: 1, type: 'TTS_STOP' }, panel)).toMatchObject({ ok: true });
    expect(await h.call({ v: 1, type: 'GET_PUBLIC_SETTINGS' }, panel)).toMatchObject({ ok: true });
    expect(await h.call({ v: 1, type: 'AI_CANCEL', requestId: REQ_A }, panel)).toMatchObject({
      ok: true,
    });
    expect(await h.call({ v: 1, type: 'OPEN_SETTINGS', section: 'key' }, panel)).toMatchObject({
      ok: true,
    });
  });

  it('can never reach key, settings, status, card-loading or hand-off-creating routes', async () => {
    const panel = panelSender(5);
    const messages = [
      ...Object.values(KEY_MESSAGES),
      ...Object.values(SETTINGS_MESSAGES),
      { v: 1, type: 'GET_AI_STATUS' },
      CARD_MESSAGES['LOAD_EXPLAIN_CARD'],
      CARD_MESSAGES['LOAD_TOOLBAR'],
      openSidePanelMessage(),
    ];
    for (const message of messages) {
      expect(await h.call(message, panel), JSON.stringify(message).slice(0, 60)).toMatchObject(
        INVALID,
      );
    }
    expect(h.local.keys().filter((k) => k.includes('key')).length).toBeGreaterThan(0);
  });

  it('adds no disclosure path: the panel cannot acknowledge, a refused flag sends nothing', async () => {
    const classified = classifySender(panelSender(5), {
      runtimeId: RUNTIME_ID,
      extensionOrigin: `${ORIGIN}/`,
    });
    expect(mayAcknowledgeDisclosure(classified)).toBe(false);
    const fresh = createHarness();
    await fresh.call(KEY_MESSAGES['SET_API_KEY'], pageSender('/options.html'));
    // Key present, disclosure never accepted: the panel sees the same prompt request as the card.
    expect(await fresh.call(explainMessage(REQ_A), panelSender(5))).toMatchObject({
      ok: false,
      error: { code: 'SETUP_REQUIRED', reason: 'disclosure' },
    });
    expect(
      await fresh.call({ ...explainMessage(REQ_A), acknowledgeDisclosure: true }, panelSender(5)),
    ).toMatchObject(INVALID);
    expect(fresh.provider.explain).not.toHaveBeenCalled();
    // The record of the acknowledgement was not written.
    expect(
      await fresh.call(SETTINGS_MESSAGES['GET_SETTINGS'], pageSender('/options.html')),
    ).toMatchObject({ ok: true, data: { onboarding: { disclosureAcceptedAt: null } } });
  });

  it('keeps one request in flight per panel TAB, so two windows do not cancel each other', async () => {
    const gates: Array<() => void> = [];
    h.provider.explain.mockImplementation(
      (request) =>
        new Promise((resolve) => {
          gates.push(() => resolve({ ...request, ...{ summary: 'x' } } as never));
        }),
    );
    const a = h.send(explainMessage(REQ_A), panelSender(1));
    const b = h.send(explainMessage(REQ_B), panelSender(2));
    await vi.waitFor(() => expect(h.provider.explain).toHaveBeenCalledTimes(2));
    // Neither was aborted by the other.
    for (const call of h.provider.explain.mock.calls) {
      expect(call[1]?.signal?.aborted).toBe(false);
    }
    // A newer request from the SAME panel does abort its previous one.
    void h.send(explainMessage('33333333-3333-4333-8333-333333333333'), panelSender(1));
    await vi.waitFor(() => expect(h.provider.explain).toHaveBeenCalledTimes(3));
    expect(h.provider.explain.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(h.provider.explain.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
    for (const gate of gates) gate();
    await Promise.allSettled([a.reply, b.reply]);
  });
});
