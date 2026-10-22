import { describe, expect, it } from 'vitest';
import { KEY_ROUTES, errorEnvelopeSchema } from '../../../lib/contracts';
import { createMessageListener, defineRoute, parseWith } from '../../../lib/router/router';
import {
  FAKE_KEY,
  KEY_MESSAGES,
  ORIGIN,
  PRIVILEGED_MESSAGES,
  PUBLIC_MESSAGES,
  REQ_A,
  RUNTIME_ID,
  SETTINGS_MESSAGES,
  contentSender,
  createHarness,
  makeReady,
  offscreenSender,
  pageSender,
  popupSender,
} from './harness';

const INVALID = { ok: false, error: { code: 'INVALID_REQUEST', message: expect.any(String) } };

describe('sender matrix: privileged routes', () => {
  it('a website content script is rejected on EVERY privileged route, without side effects', async () => {
    const h = createHarness();
    for (const [type, message] of Object.entries(PRIVILEGED_MESSAGES)) {
      const reply = await h.call(message, contentSender());
      expect(reply, type).toMatchObject(INVALID);
    }
    // Nothing was stored, read or called on its behalf.
    expect(h.local.keys()).toEqual([]);
    expect(h.session.keys()).toEqual([]);
    expect(h.provider.listModels).not.toHaveBeenCalled();
  });

  it('key routes (KEY_ROUTES) come only from /options.html and /onboarding.html', async () => {
    expect([...KEY_ROUTES].sort()).toEqual(Object.keys(KEY_MESSAGES).sort());
    const rejected = [
      ['reader', pageSender('/reader.html')],
      ['popup', popupSender()],
      ['practice', pageSender('/practice.html')],
      ['offscreen', offscreenSender()],
      ['content', contentSender()],
    ] as const;
    for (const [who, sender] of rejected) {
      for (const [type, message] of Object.entries(KEY_MESSAGES)) {
        const h = createHarness();
        expect(await h.call(message, sender), `${who} -> ${type}`).toMatchObject(INVALID);
        expect(h.local.keys(), `${who} -> ${type} wrote`).toEqual([]);
      }
    }
    for (const path of ['/options.html', '/onboarding.html']) {
      for (const [type, message] of Object.entries(KEY_MESSAGES)) {
        const h = createHarness();
        // TEST_API_KEY with no stored key is a SETUP_REQUIRED failure: allowed, but nothing to test.
        const reply = await h.call(message, pageSender(path));
        expect(reply, `${path} -> ${type}`).not.toMatchObject(INVALID);
        expect(reply, `${path} -> ${type}`).toHaveProperty('ok');
      }
    }
  });

  it('settings and status routes also accept the popup, but never the reader or offscreen', async () => {
    for (const [type, message] of Object.entries(SETTINGS_MESSAGES)) {
      const h = createHarness();
      for (const sender of [
        popupSender(),
        pageSender('/options.html'),
        pageSender('/onboarding.html'),
      ]) {
        expect(await h.call(message, sender), `${sender.url} -> ${type}`).toMatchObject({
          ok: true,
        });
      }
      for (const sender of [
        pageSender('/reader.html'),
        pageSender('/practice.html'),
        offscreenSender(),
      ]) {
        expect(await h.call(message, sender), `${sender.url} -> ${type}`).toMatchObject(INVALID);
      }
    }
  });

  it('rejects a sender whose id is not this extension, on every route', async () => {
    const h = createHarness();
    const stranger = (sender: object) => ({ ...sender, id: 'ffffffffffffffffffffffffffffffff' });
    const messages = { ...PUBLIC_MESSAGES, ...PRIVILEGED_MESSAGES };
    for (const [type, message] of Object.entries(messages)) {
      for (const sender of [pageSender('/options.html'), contentSender(), popupSender()]) {
        expect(await h.call(message, stranger(sender)), type).toMatchObject(INVALID);
      }
    }
    // Missing id, missing url and garbage senders are rejected too.
    for (const sender of [
      {},
      { id: RUNTIME_ID },
      { url: `${ORIGIN}/options.html` },
      null as never,
    ]) {
      expect(await h.call(KEY_MESSAGES['GET_KEY_STATUS'], sender)).toMatchObject(INVALID);
    }
  });

  it('does not trust an extension page that is embedded in a website', async () => {
    const h = createHarness();
    const embedded = {
      id: RUNTIME_ID,
      url: `${ORIGIN}/options.html`,
      frameId: 3,
      tab: { id: 4, url: 'https://evil.example/' },
    };
    expect(await h.call(KEY_MESSAGES['GET_KEY_STATUS'], embedded)).toMatchObject(INVALID);
    expect(await h.call(SETTINGS_MESSAGES['GET_SETTINGS'], embedded)).toMatchObject(INVALID);
  });

  it('matches extension pages by EXACT path, not by prefix or look-alike', async () => {
    const h = createHarness();
    for (const url of [
      `${ORIGIN}/options.html.evil`,
      `${ORIGIN}/options.htm`,
      `${ORIGIN}/sub/options.html`,
      `${ORIGIN}/options.htmlx`,
      `${ORIGIN}/other.html`,
      `${ORIGIN}/content-scripts/content.js`,
      `${ORIGIN}.evil.example/options.html`,
      `https://evil.example/${ORIGIN}/options.html`,
    ]) {
      const reply = await h.call(KEY_MESSAGES['GET_KEY_STATUS'], {
        id: RUNTIME_ID,
        url,
        tab: { id: 1 },
      });
      expect(reply, url).toMatchObject(INVALID);
    }
    // A query string or fragment does not change the page.
    expect(
      await h.call(KEY_MESSAGES['GET_KEY_STATUS'], {
        id: RUNTIME_ID,
        url: `${ORIGIN}/options.html?tab=key#top`,
        frameId: 0,
        tab: { id: 1, url: `${ORIGIN}/options.html?tab=key#top` },
      }),
    ).toMatchObject({ ok: true });
  });
});

describe('sender matrix: public routes', () => {
  it('accept content scripts, the reader, the practice page and the other extension pages', async () => {
    for (const [type, message] of Object.entries(PUBLIC_MESSAGES)) {
      const senders = [
        contentSender(),
        pageSender('/reader.html'),
        pageSender('/practice.html'),
        pageSender('/options.html'),
        pageSender('/onboarding.html'),
        popupSender(),
      ];
      for (const sender of senders) {
        const h = createHarness();
        await makeReady(h);
        const reply = (await h.call(message, sender)) as { ok: boolean };
        expect(reply, `${sender.url} -> ${type}`).toHaveProperty('ok');
      }
    }
  });

  it('rejects the offscreen document and unknown senders', async () => {
    const h = createHarness();
    for (const [type, message] of Object.entries(PUBLIC_MESSAGES)) {
      expect(await h.call(message, offscreenSender()), type).toMatchObject(INVALID);
      expect(
        await h.call(message, { id: RUNTIME_ID, url: 'https://evil.example/' }),
        type,
      ).toMatchObject(INVALID);
    }
  });

  it('does not accept a content script on a non-web page', async () => {
    const h = createHarness();
    for (const url of [
      'file:///etc/passwd',
      'chrome://settings',
      'data:text/html,x',
      'ftp://x.test/',
    ]) {
      const reply = await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], {
        id: RUNTIME_ID,
        url,
        tab: { id: 1 },
      });
      expect(reply, url).toMatchObject(INVALID);
    }
    // about:blank / srcdoc frames of a web page are content scripts too (matchOriginAsFallback).
    for (const url of ['about:blank', 'about:srcdoc']) {
      expect(
        await h.call(PUBLIC_MESSAGES['GET_PUBLIC_SETTINGS'], {
          id: RUNTIME_ID,
          url,
          tab: { id: 1 },
        }),
      ).toMatchObject({ ok: true });
    }
  });
});

describe('unknown and invalid messages', () => {
  it('returns undefined (no reply, channel not claimed) for unknown types and non-objects', async () => {
    const h = createHarness();
    const unowned = [
      { v: 1, type: 'GET_API_KEY' },
      { v: 1, type: 'TTS_EVENT', requestId: REQ_A, state: 'ended' },
      { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_GET_VOICES' },
      { v: 1, type: 'SOMETHING_ELSE' },
      { type: 5 },
      {},
      'hello',
      null,
      undefined,
      42,
      [],
    ];
    for (const message of unowned) {
      for (const sender of [contentSender(), pageSender('/options.html'), offscreenSender(), {}]) {
        const { claimed, reply } = h.send(message, sender);
        expect(claimed, JSON.stringify(message)).toBeUndefined();
        expect(await reply).toBeUndefined();
      }
    }
  });

  it('replies INVALID_REQUEST to a known type with a bad shape, without echoing the input', async () => {
    const h = createHarness();
    const secret = 'gsk_TESTsecretvaluethatmustnotbeechoed';
    const bad = [
      { v: 1, type: 'SET_API_KEY', apiKey: secret, storage: 'sync' },
      { v: 1, type: 'SET_API_KEY', apiKey: `${secret} with space`, storage: 'local' },
      { v: 1, type: 'SET_API_KEY', apiKey: secret, storage: 'local', extra: secret },
      { v: 2, type: 'GET_KEY_STATUS' },
      { v: 1, type: 'UPDATE_PREFERENCES', patch: {} },
      { v: 1, type: 'UPDATE_PREFERENCES', patch: { ttsRate: 9, note: secret } },
      { v: 1, type: 'UPDATE_ONBOARDING' },
    ];
    for (const message of bad) {
      const reply = await h.call(message, pageSender('/options.html'));
      expect(reply, JSON.stringify(message)).toMatchObject(INVALID);
      expect(JSON.stringify(reply)).not.toContain(secret);
      expect(errorEnvelopeSchema.safeParse((reply as { error: unknown }).error).success).toBe(true);
    }
    expect(h.local.keys()).toEqual([]);
  });

  it('echoes only a well-formed UUID requestId on a rejection', async () => {
    const h = createHarness();
    const withId = (requestId: string) => ({ v: 1, type: 'AI_CANCEL', requestId, extra: 1 });
    expect(await h.call(withId(REQ_A), contentSender())).toEqual({
      ok: false,
      requestId: REQ_A,
      error: expect.objectContaining({ code: 'INVALID_REQUEST' }),
    });
    expect(await h.call(withId('gsk_TESTnot-a-uuid'), contentSender())).not.toHaveProperty(
      'requestId',
    );
  });

  it('rejects an oversized message before parsing it', async () => {
    const h = createHarness();
    const huge = { v: 1, type: 'TTS_SPEAK', requestId: REQ_A, text: 'x'.repeat(40_000), rate: 1 };
    expect(await h.call(huge, contentSender())).toMatchObject({
      ok: false,
      error: { code: 'SELECTION_TOO_LONG' },
    });
    expect(h.chromeTts.speakCalls).toHaveLength(0);
  });

  it('keeps the privileged parser away from public senders even if the type is public-looking', async () => {
    const h = createHarness();
    // A content script cannot reach GET_SETTINGS by pretending to be GET_PUBLIC_SETTINGS.
    const reply = (await h.call(
      { v: 1, type: 'GET_PUBLIC_SETTINGS', apiKey: FAKE_KEY },
      contentSender(),
    )) as object;
    expect(reply).toMatchObject(INVALID);
  });
});

describe('listener behaviour', () => {
  it('keeps the channel open (returns true) for routes that reply asynchronously', () => {
    const h = createHarness();
    const { claimed } = h.send(PUBLIC_MESSAGES['GET_AI_STATUS'], contentSender());
    expect(claimed).toBe(true);
  });

  it('answers a rejected sender synchronously and does not keep the channel open', () => {
    const h = createHarness();
    const { claimed } = h.send(KEY_MESSAGES['GET_KEY_STATUS'], contentSender());
    expect(claimed).toBeUndefined();
  });

  it('turns a throwing handler into an error envelope that never carries the error text', async () => {
    const route = defineRoute({
      type: 'BOOM',
      allow: { content: true },
      parse: parseWith((raw) => ({ success: true as const, data: raw })),
      handle: () => Promise.reject(new Error('gsk_TESTleaked-in-error-message')),
    });
    const listener = createMessageListener({
      identity: { runtimeId: RUNTIME_ID, extensionOrigin: ORIGIN },
      routes: [route],
    });
    const reply = await new Promise((resolve) =>
      listener({ type: 'BOOM' }, contentSender(), resolve),
    );
    expect(reply).toMatchObject({ ok: false });
    expect(JSON.stringify(reply)).not.toContain('gsk_TEST');
  });

  it('refuses a table with duplicate route types', () => {
    const route = defineRoute({
      type: 'X',
      allow: {},
      parse: parseWith((raw) => ({ success: true as const, data: raw })),
      handle: () => undefined,
    });
    expect(() =>
      createMessageListener({
        identity: { runtimeId: RUNTIME_ID, extensionOrigin: ORIGIN },
        routes: [route, route],
      }),
    ).toThrow(/Duplicate route/);
  });

  it('only allows what the table says: every route has a non-empty sender rule', () => {
    const h = createHarness();
    for (const route of h.routes) {
      const rule = route.allow;
      expect(
        rule.content === true || rule.offscreen === true || (rule.pages?.length ?? 0) > 0,
        route.type,
      ).toBe(true);
    }
  });
});

describe('internal routes keep their own reply shapes', () => {
  it('CLAVIS_INJECT_UI: content scripts only, {ok:false, reason} otherwise', async () => {
    const h = createHarness();
    const message = { v: 1, type: 'CLAVIS_INJECT_UI' };
    expect(await h.call(message, contentSender(12))).toEqual({ ok: true, shown: false });
    expect(h.injection.scripting.executeScript).toHaveBeenCalledWith({
      target: { tabId: 12, frameIds: [0] },
      files: ['/content-scripts/content-ui.js'],
    });
    for (const sender of [popupSender(), pageSender('/options.html'), offscreenSender(), {}]) {
      expect(await h.call(message, sender)).toEqual({ ok: false, reason: 'failed' });
    }
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('CLAVIS_INJECT_UI: refuses restricted frames but serves about:blank', async () => {
    const h = createHarness();
    const message = { v: 1, type: 'CLAVIS_INJECT_UI' };
    expect(
      await h.call(message, {
        id: RUNTIME_ID,
        url: 'about:blank',
        frameId: 4,
        tab: { id: 2 },
      }),
    ).toEqual({ ok: true, shown: false });
  });

  it('CLAVIS_INJECT_TAB: the popup only', async () => {
    const h = createHarness();
    const message = { v: 1, type: 'CLAVIS_INJECT_TAB', tabId: 3, url: 'https://a.test/' };
    expect(await h.call(message, popupSender())).toEqual({ ok: true, shown: true });
    for (const sender of [
      contentSender(),
      pageSender('/reader.html'),
      pageSender('/options.html'),
    ]) {
      expect(await h.call(message, sender)).toEqual({ ok: false, reason: 'failed' });
    }
    expect(await h.call({ ...message, tabId: '3' }, popupSender())).toEqual({
      ok: false,
      reason: 'failed',
    });
    expect(h.injection.scripting.executeScript).toHaveBeenCalledTimes(1);
  });

  it('SPEECH_DIAGNOSE: popup/options/onboarding only', async () => {
    const h = createHarness();
    const message = { v: 1, type: 'SPEECH_DIAGNOSE' };
    expect(await h.call(message, popupSender())).toMatchObject({ ok: true });
    for (const sender of [contentSender(), pageSender('/reader.html'), offscreenSender()]) {
      expect(await h.call(message, sender)).toMatchObject(INVALID);
    }
  });

  it('SPEECH_OFFSCREEN_* events: only the offscreen document is heard, and nobody gets a reply', async () => {
    const h = createHarness();
    const event = { v: 1, type: 'SPEECH_OFFSCREEN_EVENT', requestId: REQ_A, state: 'ended' };
    const idle = { v: 1, type: 'SPEECH_OFFSCREEN_IDLE' };
    for (const message of [event, idle]) {
      for (const sender of [
        offscreenSender(),
        contentSender(),
        popupSender(),
        pageSender('/reader.html'),
      ]) {
        const { claimed, reply } = h.send(message, sender);
        expect(claimed).toBeUndefined();
        expect(await reply).toBeUndefined();
      }
    }
  });
});
