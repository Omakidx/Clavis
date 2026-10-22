import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { createSpeechRouter, registerSpeech } from '../../../lib/speech/background';
import { SpeechService } from '../../../lib/speech/service';
import type { TtsEventMessage } from '../../../lib/speech/messages';
import { FakeEngine, ID_A, ID_B, voice } from './helpers';

const EXT = 'chrome-extension://abc/';
const OFFSCREEN = `${EXT}offscreen.html`;

function setup(chromeVoices = [voice('chrome-tts', 'en-US')]) {
  const chrome = new FakeEngine('chrome-tts', chromeVoices);
  const offscreenFake = new FakeEngine('offscreen-web-speech', []);
  const service = new SpeechService({ engines: [chrome, offscreenFake], startTimeoutMs: 1_000 });
  const handlePageEvent = vi.fn();
  const handlePageIdle = vi.fn();
  const pushed: { target: object; message: TtsEventMessage }[] = [];
  const route = createSpeechRouter({
    service,
    offscreenEngine: { handlePageEvent, handlePageIdle },
    runtimeId: 'abc',
    extensionUrlPrefix: EXT,
    offscreenPageUrl: OFFSCREEN,
    push: (target, message) => {
      pushed.push({ target, message });
      return Promise.resolve();
    },
    offscreenApi: { getContexts: true, hasDocument: true, matchClients: true },
    userAgent: 'test',
  });
  return { chrome, service, route, handlePageEvent, handlePageIdle, pushed };
}

const SELF = { id: 'abc', url: 'https://example.com/page', tab: { id: 7 }, frameId: 2 };
const speakMsg = (over: object = {}) => ({
  v: 1,
  type: 'TTS_SPEAK',
  requestId: ID_A,
  text: 'bank',
  rate: 1,
  ...over,
});

beforeEach(() => {
  vi.useFakeTimers();
  // The fake browser has no in-memory i18n; the catalog is covered by tests/unit/i18n.
  vi.spyOn(fakeBrowser.i18n, 'getMessage').mockImplementation((key) => `msg:${key}`);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('speech router', () => {
  it('replies to TTS_SPEAK with an ok envelope only once audio has started', async () => {
    const { route } = setup();
    const reply = await route(speakMsg({ lang: 'en-US' }), SELF);
    expect(reply).toEqual({
      ok: true,
      requestId: ID_A,
      data: {
        engine: 'chrome-tts',
        voiceName: 'chrome-tts-en-US',
        lang: 'en-US',
        remote: false,
        state: 'started',
      },
    });
  });

  it('replies NO_VOICE (never ok) when no engine has a voice', async () => {
    const { route } = setup([]);
    const reply = (await route(speakMsg(), SELF)) as {
      ok: boolean;
      requestId: string;
      error: { code: string; message: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.requestId).toBe(ID_A);
    expect(reply.error.code).toBe('NO_VOICE');
    expect(reply.error.message).toMatch(/\S/);
    expect(reply).not.toHaveProperty('data');
  });

  it('replies with an error envelope for invalid speak requests', async () => {
    const { route, chrome } = setup();
    const badRate = (await route(speakMsg({ rate: 9 }), SELF)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(badRate.ok).toBe(false);
    expect(badRate.error.code).not.toBe('NO_VOICE');
    const tooLong = await route(speakMsg({ text: 'x'.repeat(2001) }), SELF);
    expect(tooLong).toMatchObject({ ok: false, error: { code: 'SELECTION_TOO_LONG' } });
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('rejects senders that are not this extension', async () => {
    const { route, chrome } = setup();
    const reply = await route(speakMsg(), { id: 'someone-else', tab: { id: 1 } });
    expect(reply).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('claims only TTS_SPEAK/TTS_STOP (and its own internal types); everything else returns undefined', () => {
    const { route } = setup();
    for (const message of [
      { v: 1, type: 'AI_EXPLAIN' },
      { v: 1, type: 'GET_PUBLIC_SETTINGS' },
      { v: 1, type: 'GET_AI_STATUS' },
      { v: 1, type: 'SET_API_KEY' },
      { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_GET_VOICES' },
      { type: 'TTS_EVENT' },
      'hello',
      null,
      42,
      {},
    ]) {
      expect(route(message, SELF), JSON.stringify(message)).toBeUndefined();
    }
  });

  it('handles TTS_STOP with and without a requestId', async () => {
    const { route } = setup();
    await route(speakMsg(), SELF);
    expect(await route({ v: 1, type: 'TTS_STOP', requestId: ID_B }, SELF)).toEqual({
      ok: true,
      requestId: ID_B,
      data: { stopped: false },
    });
    expect(await route({ v: 1, type: 'TTS_STOP' }, SELF)).toEqual({
      ok: true,
      data: { stopped: true },
    });
    expect(await route({ v: 1, type: 'TTS_STOP', requestId: 'not-a-uuid' }, SELF)).toMatchObject({
      ok: false,
    });
  });

  it('pushes terminal states (not started) to the tab and frame that asked', async () => {
    const { route, chrome, pushed } = setup();
    await route(speakMsg(), SELF);
    expect(pushed).toHaveLength(0);
    chrome.emit({ state: 'ended' });
    expect(pushed).toEqual([
      {
        target: { tabId: 7, frameId: 2 },
        message: { v: 1, type: 'TTS_EVENT', requestId: ID_A, state: 'ended' },
      },
    ]);
  });

  it('pushes cancelled to the first page when a second request replaces it', async () => {
    const { route, pushed } = setup();
    await route(speakMsg({ requestId: ID_A }), { ...SELF, tab: { id: 1 } });
    await route(speakMsg({ requestId: ID_B }), { ...SELF, tab: { id: 2 } });
    expect(pushed).toEqual([
      expect.objectContaining({
        target: { tabId: 1, frameId: 2 },
        message: expect.objectContaining({ requestId: ID_A, state: 'cancelled' }),
      }),
    ]);
  });

  it('only accepts offscreen events and idle notices from the offscreen page itself', () => {
    const { route, handlePageEvent, handlePageIdle } = setup();
    const event = { v: 1, type: 'SPEECH_OFFSCREEN_EVENT', requestId: ID_A, state: 'ended' };
    route(event, SELF); // content script on a web page
    route(event, { id: 'abc', url: `${EXT}popup.html` }); // another extension page
    route(event, { id: 'other', url: OFFSCREEN });
    expect(handlePageEvent).not.toHaveBeenCalled();
    route(event, { id: 'abc', url: OFFSCREEN });
    expect(handlePageEvent).toHaveBeenCalledWith(event);

    route({ v: 1, type: 'SPEECH_OFFSCREEN_IDLE' }, SELF);
    expect(handlePageIdle).not.toHaveBeenCalled();
    route({ v: 1, type: 'SPEECH_OFFSCREEN_IDLE' }, { id: 'abc', url: OFFSCREEN });
    expect(handlePageIdle).toHaveBeenCalledTimes(1);
  });

  it('ignores malformed offscreen events', () => {
    const { route, handlePageEvent } = setup();
    route(
      { v: 1, type: 'SPEECH_OFFSCREEN_EVENT', requestId: 'x', state: 'weird' },
      {
        id: 'abc',
        url: OFFSCREEN,
      },
    );
    expect(handlePageEvent).not.toHaveBeenCalled();
  });

  it('serves diagnostics to extension pages only', async () => {
    const { route } = setup();
    const message = { v: 1, type: 'SPEECH_DIAGNOSE' };
    expect(await route(message, SELF)).toMatchObject({
      ok: false,
      error: { code: 'PERMISSION_DENIED' },
    });
    const reply = (await route(message, {
      id: 'abc',
      url: `${EXT}popup.html`,
      tab: { id: 1 },
    })) as {
      ok: boolean;
      data: { capability: { engine: string }; userAgent: string };
    };
    expect(reply.ok).toBe(true);
    expect(reply.data.capability.engine).toBe('chrome-tts');
    expect(reply.data.userAgent).toBe('test');
  });
});

describe('registerSpeech', () => {
  it('registers a runtime.onMessage listener synchronously', () => {
    registerSpeech();
    expect(fakeBrowser.runtime.onMessage.hasListeners()).toBe(true);
  });

  it('answers speech messages through the real listener and ignores everything else', async () => {
    // The fake browser has no tts implementation: an engine that throws must not break Stop.
    registerSpeech();
    const sender = { id: fakeBrowser.runtime.id };

    const ignored = await fakeBrowser.runtime.onMessage.trigger(
      { v: 1, type: 'AI_EXPLAIN' },
      sender,
      vi.fn(),
    );
    expect(ignored).toEqual([undefined]);

    const sendResponse = vi.fn();
    const results = await fakeBrowser.runtime.onMessage.trigger(
      { v: 1, type: 'TTS_STOP' },
      sender,
      sendResponse,
    );
    expect(results).toEqual([true]);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendResponse).toHaveBeenCalledWith({ ok: true, data: { stopped: false } });
  });
});
