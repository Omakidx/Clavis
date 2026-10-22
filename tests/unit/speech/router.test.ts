import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createSpeechHandlers,
  rejectedSpeakReply,
  type SpeechSender,
} from '../../../lib/speech/background';
import { SpeechService } from '../../../lib/speech/service';
import type { TtsEventMessage } from '../../../lib/speech/messages';
import { FakeEngine, ID_A, ID_B, voice } from './helpers';

function setup(chromeVoices = [voice('chrome-tts', 'en-US')]) {
  const chrome = new FakeEngine('chrome-tts', chromeVoices);
  const offscreenFake = new FakeEngine('offscreen-web-speech', []);
  const service = new SpeechService({ engines: [chrome, offscreenFake], startTimeoutMs: 1_000 });
  const handlePageEvent = vi.fn();
  const handlePageIdle = vi.fn();
  const pushed: { target: object; message: TtsEventMessage }[] = [];
  const handlers = createSpeechHandlers({
    service,
    offscreenEngine: { handlePageEvent, handlePageIdle },
    push: (target, message) => {
      pushed.push({ target, message });
      return Promise.resolve();
    },
    offscreenApi: { getContexts: true, hasDocument: true, matchClients: true },
    userAgent: 'test',
  });
  return { chrome, service, handlers, handlePageEvent, handlePageIdle, pushed };
}

const SELF: SpeechSender = { tabId: 7, frameId: 2 };
const speakMsg = (over: object = {}) =>
  ({ v: 1, type: 'TTS_SPEAK', requestId: ID_A, text: 'bank', rate: 1, ...over }) as never;
const stopMsg = (requestId?: string) =>
  ({ v: 1, type: 'TTS_STOP', ...(requestId === undefined ? {} : { requestId }) }) as never;

beforeEach(() => {
  vi.useFakeTimers();
  // The fake browser has no in-memory i18n; the catalog is covered by tests/unit/i18n.
  vi.spyOn(fakeBrowser.i18n, 'getMessage').mockImplementation((key) => `msg:${key}`);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('speech handlers', () => {
  it('replies to TTS_SPEAK with an ok envelope only once audio has started', async () => {
    const { handlers } = setup();
    const reply = await handlers.speak(speakMsg({ lang: 'en-US' }), SELF);
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
    const { handlers } = setup([]);
    const reply = (await handlers.speak(speakMsg(), SELF)) as {
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

  it('replies with an error envelope when the service rejects the request', async () => {
    const { handlers, chrome } = setup();
    const badRate = (await handlers.speak(speakMsg({ rate: Number.NaN }), SELF)) as {
      ok: boolean;
      error: { code: string };
    };
    expect(badRate.ok).toBe(false);
    expect(badRate.error.code).not.toBe('NO_VOICE');
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('builds the schema-rejection reply: SELECTION_TOO_LONG for long text, else INVALID_REQUEST', () => {
    expect(rejectedSpeakReply(speakMsg({ text: 'x'.repeat(2001) }))).toMatchObject({
      ok: false,
      requestId: ID_A,
      error: { code: 'SELECTION_TOO_LONG' },
    });
    expect(rejectedSpeakReply(speakMsg({ rate: 9 }))).toMatchObject({
      ok: false,
      error: { code: 'INVALID_REQUEST' },
    });
    // Only a well-formed UUID is echoed back.
    expect(rejectedSpeakReply(speakMsg({ rate: 9, requestId: 'secret-text' }))).not.toHaveProperty(
      'requestId',
    );
  });

  it('handles TTS_STOP with and without a requestId', async () => {
    const { handlers } = setup();
    await handlers.speak(speakMsg(), SELF);
    expect(await handlers.stop(stopMsg(ID_B), SELF)).toEqual({
      ok: true,
      requestId: ID_B,
      data: { stopped: false },
    });
    expect(await handlers.stop(stopMsg(), SELF)).toEqual({ ok: true, data: { stopped: true } });
  });

  describe('TTS_STOP is scoped to the sender (Phase 2 review, INFO)', () => {
    it('lets a tab stop only its own utterance, with or without an id', async () => {
      const { handlers, chrome } = setup();
      await handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });

      expect(await handlers.stop(stopMsg(), { tabId: 2 })).toMatchObject({
        data: { stopped: false },
      });
      expect(await handlers.stop(stopMsg(ID_A), { tabId: 2 })).toMatchObject({
        data: { stopped: false },
      });
      expect(chrome.stopCalls).toBe(0);

      expect(await handlers.stop(stopMsg(), { tabId: 1 })).toMatchObject({
        data: { stopped: true },
      });
    });

    it('lets a tab stop its own utterance by id', async () => {
      const { handlers } = setup();
      await handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      expect(await handlers.stop(stopMsg(ID_A), { tabId: 1 })).toMatchObject({
        data: { stopped: true },
      });
    });

    it('lets a tab-less extension page (the popup) stop anything', async () => {
      const { handlers } = setup();
      await handlers.speak(speakMsg(), { tabId: 1, frameId: 0 });
      expect(await handlers.stop(stopMsg(), {})).toMatchObject({ data: { stopped: true } });
    });

    it('does not let a tab stop speech started by the popup', async () => {
      const { handlers } = setup();
      await handlers.speak(speakMsg(), {});
      expect(await handlers.stop(stopMsg(), { tabId: 3 })).toMatchObject({
        data: { stopped: false },
      });
    });

    it('still reaches the engines for an id-less stop when nothing is tracked (worker restarted)', async () => {
      const { handlers, chrome } = setup();
      await handlers.stop(stopMsg(), { tabId: 3 });
      expect(chrome.stopCalls).toBe(1);
    });
  });

  it('pushes terminal states (not started) to the tab and frame that asked', async () => {
    const { handlers, chrome, pushed } = setup();
    await handlers.speak(speakMsg(), SELF);
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
    const { handlers, pushed } = setup();
    await handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 2 });
    await handlers.speak(speakMsg({ requestId: ID_B }), { tabId: 2, frameId: 2 });
    expect(pushed).toEqual([
      expect.objectContaining({
        target: { tabId: 1, frameId: 2 },
        message: expect.objectContaining({ requestId: ID_A, state: 'cancelled' }),
      }),
    ]);
  });

  it('forwards offscreen events and idle notices to the offscreen engine', () => {
    const { handlers, handlePageEvent, handlePageIdle } = setup();
    const event = {
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'ended',
    } as const;
    handlers.offscreenEvent(event);
    expect(handlePageEvent).toHaveBeenCalledWith(event);
    handlers.offscreenIdle();
    expect(handlePageIdle).toHaveBeenCalledTimes(1);
  });

  it('serves diagnostics', async () => {
    const { handlers } = setup();
    const reply = await handlers.diagnose();
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.data.capability.engine).toBe('chrome-tts');
      expect(reply.data.userAgent).toBe('test');
    }
  });
});
