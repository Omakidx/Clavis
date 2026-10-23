import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import {
  createSpeechHandlers,
  rejectedSpeakReply,
  toPlatform,
  toVoiceInfos,
  type PushTarget,
  type SpeechSender,
} from '../../../lib/speech/background';
import { SpeechService } from '../../../lib/speech/service';
import type { TtsEventMessage } from '../../../lib/contracts';
import { voicesReportSchema } from '../../../lib/contracts';
import { FakeEngine, ID_A, ID_B, voice } from './helpers';

interface SetupOptions {
  chromeVoices?: ReturnType<typeof voice>[];
  preferences?: { ttsLang?: string; ttsVoice?: string };
  os?: 'linux' | 'mac' | 'win' | 'cros' | 'android' | 'other';
}

function setup(options: SetupOptions = {}) {
  const chrome = new FakeEngine(
    'chrome-tts',
    options.chromeVoices ?? [voice('chrome-tts', 'en-US')],
  );
  const service = new SpeechService({ engine: chrome, startTimeoutMs: 1_000 });
  const pushed: { target: PushTarget; message: TtsEventMessage }[] = [];
  const preferences = vi.fn(() => Promise.resolve(options.preferences ?? {}));
  const handlers = createSpeechHandlers({
    service,
    push: (target, message) => {
      pushed.push({ target, message });
      return Promise.resolve();
    },
    preferences,
    platform: () => Promise.resolve(options.os ?? 'mac'),
  });
  return {
    chrome,
    service,
    handlers,
    pushed,
    preferences,
  };
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
    const { handlers } = setup({ chromeVoices: [] });
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

    it('also reaches the engines for a stop WITH an id the restarted worker does not know (M1)', async () => {
      const { handlers, chrome } = setup();
      expect(await handlers.stop(stopMsg(ID_A), { tabId: 3 })).toEqual({
        ok: true,
        requestId: ID_A,
        data: { stopped: false },
      });
      expect(chrome.stopCalls).toBe(1);
    });

    it('does not stop speech of another tab when another request is tracked (stale id)', async () => {
      const { handlers, chrome } = setup();
      await handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      await handlers.stop(stopMsg(ID_B), { tabId: 3 });
      expect(chrome.stopCalls).toBe(0);
    });

    it('an id-less stop checks ownership of the utterance being spoken, not of any tracked one (L4)', async () => {
      const { handlers, chrome, pushed } = setup();
      await handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      // Tab 2 asks too; its request supersedes tab 1's, so tab 1 no longer owns what plays.
      await handlers.speak(speakMsg({ requestId: ID_B }), { tabId: 2, frameId: 0 });
      expect(pushed.map((p) => p.message.state)).toEqual(['cancelled']);
      expect(await handlers.stop(stopMsg(), { tabId: 1 })).toMatchObject({
        data: { stopped: false },
      });
      expect(chrome.stopCalls).toBe(1); // only the supersede
      expect(await handlers.stop(stopMsg(), { tabId: 2 })).toMatchObject({
        data: { stopped: true },
      });
    });
  });

  describe('a Stop never loses the race against the audio it stops (H1)', () => {
    it('stop during the preferences read: the request is cancelled and no audio starts', async () => {
      const { handlers, chrome, preferences } = setup();
      let release: (() => void) | undefined;
      preferences.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      );
      const speaking = handlers.speak(speakMsg({ requestId: ID_A }), SELF);
      expect(await handlers.stop(stopMsg(ID_A), SELF)).toMatchObject({ data: { stopped: true } });
      release?.();
      expect(await speaking).toMatchObject({
        ok: false,
        requestId: ID_A,
        error: { code: 'REQUEST_CANCELLED' },
      });
      await vi.advanceTimersByTimeAsync(2_000);
      expect(chrome.speakCalls).toHaveLength(0);
    });

    it("an id-less stop cancels the sender's own preparing request, not another tab's", async () => {
      const { handlers, chrome, preferences } = setup();
      const releases: (() => void)[] = [];
      preferences.mockImplementation(
        () =>
          new Promise((resolve) => {
            releases.push(() => resolve({}));
          }),
      );
      const own = handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      expect(await handlers.stop(stopMsg(), { tabId: 2 })).toMatchObject({
        data: { stopped: false },
      });
      expect(await handlers.stop(stopMsg(), { tabId: 1 })).toMatchObject({
        data: { stopped: true },
      });
      for (const release of releases) release();
      expect(await own).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
      expect(chrome.speakCalls).toHaveLength(0);
    });

    it('stop while the voices are still being looked up: no audio starts afterwards', async () => {
      const { handlers, chrome } = setup({ chromeVoices: [] });
      chrome.getVoicesDelayMs = 1_500;
      chrome.voices = [voice('chrome-tts', 'en-US')];
      const speaking = handlers.speak(speakMsg({ requestId: ID_A, lang: 'en' }), SELF);
      await vi.advanceTimersByTimeAsync(200);
      expect(await handlers.stop(stopMsg(ID_A), SELF)).toMatchObject({ data: { stopped: true } });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(await speaking).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
      expect(chrome.speakCalls).toHaveLength(0);
    });

    it('another tab cannot stop a request that is still being prepared', async () => {
      const { handlers, chrome, preferences } = setup();
      let release: (() => void) | undefined;
      preferences.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({});
          }),
      );
      const speaking = handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      expect(await handlers.stop(stopMsg(ID_A), { tabId: 2 })).toMatchObject({
        data: { stopped: false },
      });
      release?.();
      expect(await speaking).toMatchObject({ ok: true });
      expect(chrome.speakCalls).toHaveLength(1);
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

  describe('voice and language choice from preferences', () => {
    it('speaks with the message language, else the saved language, and refines a bare language', async () => {
      const gb = voice('chrome-tts', 'en-GB', { name: 'Daniel' });
      const us = voice('chrome-tts', 'en-US', { name: 'Alex' });
      const fr = voice('chrome-tts', 'fr-FR', { name: 'Amelie' });
      const { handlers, chrome } = setup({
        chromeVoices: [us, gb, fr],
        preferences: { ttsLang: 'en-GB' },
      });
      await handlers.speak(speakMsg({ requestId: ID_A }), SELF);
      expect(chrome.speakCalls.at(-1)?.voice?.name).toBe('Daniel');
      // A detected "en" is refined by the preferred British English.
      await handlers.speak(speakMsg({ requestId: ID_B, lang: 'en' }), SELF);
      expect(chrome.speakCalls.at(-1)?.voice?.name).toBe('Daniel');
      // A different language in the message wins over the preference.
      await handlers.speak(speakMsg({ requestId: ID_A, lang: 'fr' }), SELF);
      expect(chrome.speakCalls.at(-1)?.voice?.name).toBe('Amelie');
    });

    it('uses the saved voice, and says which voice spoke when it disappeared', async () => {
      const a = voice('chrome-tts', 'en-US', { name: 'Alex' });
      const d = voice('chrome-tts', 'en-GB', { name: 'Daniel' });
      const present = setup({ chromeVoices: [a, d], preferences: { ttsVoice: 'Daniel' } });
      expect(await present.handlers.speak(speakMsg({ lang: 'en' }), SELF)).toMatchObject({
        data: { voiceName: 'Daniel', lang: 'en-GB' },
      });
      const missing = setup({ chromeVoices: [a], preferences: { ttsVoice: 'Daniel' } });
      expect(await missing.handlers.speak(speakMsg({ lang: 'en' }), SELF)).toMatchObject({
        ok: true,
        data: { voiceName: 'Alex' },
      });
    });

    it('an explicit voiceName beats the saved voice; a missing one is NO_VOICE, not a stand-in', async () => {
      const a = voice('chrome-tts', 'en-US', { name: 'Alex' });
      const d = voice('chrome-tts', 'en-GB', { name: 'Daniel' });
      const { handlers, chrome } = setup({
        chromeVoices: [a, d],
        preferences: { ttsVoice: 'Daniel' },
      });
      expect(await handlers.speak(speakMsg({ voiceName: 'Alex' }), SELF)).toMatchObject({
        data: { voiceName: 'Alex' },
      });
      const reply = await handlers.speak(speakMsg({ requestId: ID_B, voiceName: 'Nobody' }), SELF);
      expect(reply).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
      expect(chrome.speakCalls).toHaveLength(1);
    });

    it('uses a network voice only when the user chose it, and reports it as remote', async () => {
      const net = voice('chrome-tts', 'en-US', { name: 'Net', remote: true });
      const explicit = setup({ chromeVoices: [net] });
      expect(await explicit.handlers.speak(speakMsg({ voiceName: 'Net' }), SELF)).toMatchObject({
        data: { voiceName: 'Net', remote: true },
      });
      const saved = setup({ chromeVoices: [net], preferences: { ttsVoice: 'Net' } });
      expect(await saved.handlers.speak(speakMsg({ lang: 'en' }), SELF)).toMatchObject({
        data: { voiceName: 'Net', remote: true },
      });
    });

    it('never picks a network voice on its own (D-22): on-device voice, or NO_VOICE', async () => {
      const local = voice('chrome-tts', 'en-US', { name: 'Local' });
      const net = voice('chrome-tts', 'en-US', { name: 'Net', remote: true });
      for (const lang of ['en', undefined]) {
        const both = setup({ chromeVoices: [net, local] });
        expect(await both.handlers.speak(speakMsg({ lang }), SELF)).toMatchObject({
          data: { voiceName: 'Local', remote: false },
        });
        const onlyNet = setup({ chromeVoices: [net] });
        const reply = await onlyNet.handlers.speak(speakMsg({ lang }), SELF);
        expect(reply).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
        expect(onlyNet.chrome.speakCalls).toHaveLength(0);
      }
    });

    it('without any language an on-device voice speaks, never an unknown default', async () => {
      const local = voice('chrome-tts', 'de-DE', { name: 'Local' });
      const { handlers, chrome } = setup({ chromeVoices: [local] });
      expect(await handlers.speak(speakMsg(), SELF)).toMatchObject({
        data: { voiceName: 'Local', remote: false },
      });
      expect(chrome.speakCalls[0]?.voice?.name).toBe('Local');
    });

    it('reads no preference it cannot read: a failing store behaves like no preferences', async () => {
      const { handlers, preferences } = setup();
      preferences.mockRejectedValueOnce(new Error('storage down'));
      expect(await handlers.speak(speakMsg(), SELF)).toMatchObject({ ok: true });
    });

    it('sanitises what the engine reported: a language tag that is not a tag is omitted', async () => {
      const { handlers } = setup({
        chromeVoices: [voice('chrome-tts', 'english (united states)', { name: 'Odd' })],
      });
      const reply = (await handlers.speak(speakMsg({ voiceName: 'Odd' }), SELF)) as {
        data: Record<string, unknown>;
      };
      expect(reply.data).not.toHaveProperty('lang');
      expect(reply.data['voiceName']).toBe('Odd');
    });

    it('lets a newer request win when it overtakes one still reading preferences', async () => {
      const { handlers, chrome, preferences } = setup();
      let releaseFirst: (() => void) | undefined;
      preferences.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => resolve({});
          }),
      );
      const first = handlers.speak(speakMsg({ requestId: ID_A }), SELF);
      const second = await handlers.speak(speakMsg({ requestId: ID_B }), SELF);
      expect(second).toMatchObject({ ok: true, requestId: ID_B });
      releaseFirst?.();
      expect(await first).toMatchObject({
        ok: false,
        requestId: ID_A,
        error: { code: 'REQUEST_CANCELLED' },
      });
      expect(chrome.speakCalls.map((c) => c.requestId)).toEqual([ID_B]);
    });
  });

  describe('NO_VOICE and the Linux reason', () => {
    it('adds reason no-voice-linux on Linux when no engine has any voice', async () => {
      const { handlers } = setup({ chromeVoices: [], os: 'linux' });
      const reply = (await handlers.speak(speakMsg(), SELF)) as {
        ok: boolean;
        requestId: string;
        error: { code: string; reason?: string; message: string };
      };
      expect(reply.ok).toBe(false);
      expect(reply.requestId).toBe(ID_A);
      expect(reply.error).toMatchObject({ code: 'NO_VOICE', reason: 'no-voice-linux' });
      expect(reply).not.toHaveProperty('data');
    });

    it('has no reason on other systems when there is no voice at all', async () => {
      for (const os of ['mac', 'win', 'cros', 'other'] as const) {
        const { handlers } = setup({ chromeVoices: [], os });
        const reply = await handlers.speak(speakMsg(), SELF);
        expect(reply).toMatchObject({ error: { code: 'NO_VOICE' } });
        expect(reply).not.toHaveProperty('error.reason');
      }
    });

    it('says no-voice-language when voices exist but none speak the language (any OS)', async () => {
      for (const os of ['linux', 'mac'] as const) {
        const { handlers } = setup({ os });
        expect(await handlers.speak(speakMsg({ lang: 'fr' }), SELF)).toMatchObject({
          ok: false,
          error: { code: 'NO_VOICE', reason: 'no-voice-language' },
        });
      }
    });

    it('says start-failed when a voice was found but never started', async () => {
      const { handlers, chrome } = setup({ os: 'linux' });
      chrome.autoStart = false;
      const pending = handlers.speak(speakMsg({ lang: 'en' }), SELF);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: 'NO_VOICE', reason: 'start-failed' },
      });
    });

    it('reports network-only voices as online-only (D-22: on-device voices by default)', async () => {
      const { handlers } = setup({
        chromeVoices: [voice('chrome-tts', 'en-US', { name: 'Net', remote: true })],
      });
      expect(await handlers.speak(speakMsg({ lang: 'en' }), SELF)).toMatchObject({
        error: { code: 'NO_VOICE', reason: 'online-only' },
      });
    });

    it('treats an unreadable platform as "other" (no Linux hint), without failing', async () => {
      const chrome = new FakeEngine('chrome-tts', []);
      const handlers = createSpeechHandlers({
        service: new SpeechService({ engine: chrome }),
        push: () => Promise.resolve(),
        preferences: () => Promise.resolve({}),
        platform: () => Promise.reject(new Error('no platform')),
      });
      const reply = await handlers.speak(speakMsg(), SELF);
      expect(reply).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
      expect(reply).not.toHaveProperty('error.reason');
    });
  });

  describe('events go to exactly the asking document', () => {
    it('targets the sender document, frame and tab', async () => {
      const { handlers, chrome, pushed } = setup();
      await handlers.speak(speakMsg(), { tabId: 7, frameId: 2, documentId: 'DOC-1' });
      chrome.emit({ state: 'ended' });
      expect(pushed.map((p) => p.target)).toEqual([{ tabId: 7, frameId: 2, documentId: 'DOC-1' }]);
    });

    it('a tab-less page gets a push without a tab (runtime.sendMessage)', async () => {
      const { handlers, chrome, pushed } = setup();
      await handlers.speak(speakMsg(), {});
      chrome.emit({ state: 'error', detail: 'synthesis-failed' });
      expect(pushed).toEqual([
        {
          target: { tabId: undefined, frameId: undefined, documentId: undefined },
          message: { v: 1, type: 'TTS_EVENT', requestId: ID_A, state: 'error' },
        },
      ]);
    });

    it('never puts text, voice or detail in an event, and sends each request one terminal event', async () => {
      const { handlers, chrome, pushed } = setup();
      await handlers.speak(speakMsg({ text: 'secret sentence' }), SELF);
      chrome.emit({ state: 'ended' });
      chrome.emit({ state: 'ended' });
      expect(pushed).toHaveLength(1);
      expect(JSON.stringify(pushed[0]?.message)).not.toContain('secret');
      expect(Object.keys(pushed[0]?.message ?? {}).sort()).toEqual([
        'requestId',
        'state',
        'type',
        'v',
      ]);
    });

    it('a request superseded before it started gets no event: its reply is the cancellation', async () => {
      const { handlers, chrome, pushed } = setup();
      chrome.autoStart = false;
      const first = handlers.speak(speakMsg({ requestId: ID_A }), { tabId: 1, frameId: 0 });
      await vi.advanceTimersByTimeAsync(0);
      chrome.autoStart = true;
      const second = await handlers.speak(speakMsg({ requestId: ID_B }), { tabId: 2, frameId: 0 });
      expect(second).toMatchObject({ ok: true });
      expect(await first).toMatchObject({ ok: false, error: { code: 'REQUEST_CANCELLED' } });
      expect(pushed).toEqual([]);
    });

    it('a failing push (page gone) does not break later events', async () => {
      const { chrome, service } = setup();
      const push = vi.fn().mockRejectedValue(new Error('no receiver'));
      const handlers = createSpeechHandlers({
        service,
        push,
        preferences: () => Promise.resolve({}),
        platform: () => Promise.resolve('mac'),
      });
      await handlers.speak(speakMsg(), SELF);
      chrome.emit({ state: 'ended' });
      await vi.advanceTimersByTimeAsync(0);
      expect(push).toHaveBeenCalledTimes(1);
    });
  });

  describe('GET_VOICES report', () => {
    it('reports platform, default engine and the chrome.tts voices, with network voices marked', async () => {
      const { handlers } = setup({
        os: 'win',
        chromeVoices: [
          voice('chrome-tts', 'en_US', { name: 'Zira' }),
          voice('chrome-tts', 'de-DE', { name: 'Hedda', remote: true }),
        ],
      });
      expect(await handlers.getVoices()).toEqual({
        ok: true,
        data: {
          platform: 'win',
          defaultEngine: 'chrome-tts',
          engines: {
            chromeTts: {
              voices: [
                { name: 'Zira', lang: 'en-US', engine: 'chrome-tts', remote: false },
                { name: 'Hedda', lang: 'de-DE', engine: 'chrome-tts', remote: true },
              ],
            },
            // D-07: the offscreen fallback was not adopted; the slot stays for the contract.
            offscreen: { available: false, voices: [] },
          },
        },
      });
    });

    it('is voicesReportSchema-shaped on a machine without voices', async () => {
      const { handlers } = setup({ chromeVoices: [], os: 'linux' });
      const reply = await handlers.getVoices();
      expect(voicesReportSchema.parse((reply as { data: unknown }).data)).toEqual({
        platform: 'linux',
        defaultEngine: 'none',
        engines: { chromeTts: { voices: [] }, offscreen: { available: false, voices: [] } },
      });
    });

    it('asks the engine for a fresh list every time (speech-dispatcher installed later)', async () => {
      const { handlers, chrome } = setup({ chromeVoices: [] });
      await handlers.getVoices();
      expect(chrome.refreshCalls).toEqual([true]);
      chrome.voices = [voice('chrome-tts', 'en-US')];
      expect(await handlers.getVoices()).toMatchObject({ data: { defaultEngine: 'chrome-tts' } });
      expect(chrome.refreshCalls).toEqual([true, true]);
    });

    it('a failing engine is an empty report, not an error', async () => {
      const { handlers, chrome } = setup();
      chrome.getVoicesError = new Error('tts unavailable');
      expect(await handlers.getVoices()).toMatchObject({
        ok: true,
        data: { defaultEngine: 'none', engines: { chromeTts: { voices: [] } } },
      });
    });
  });
});

describe('toVoiceInfos', () => {
  it('keeps one usable, addressable voice per name and bounds the list', () => {
    const many = Array.from({ length: 600 }, (_, i) =>
      voice('chrome-tts', 'en-US', { name: `v${i}` }),
    );
    expect(toVoiceInfos(many)).toHaveLength(500);
    const mixed = [
      voice('chrome-tts', 'en-US', { name: 'A' }),
      voice('chrome-tts', 'en-US', { name: 'A' }),
      voice('chrome-tts', 'en-US', { name: '' }),
      voice('chrome-tts', 'en-US', { name: 'x'.repeat(129) }),
      // Lists its events without `start`: could never prove audio began.
      voice('chrome-tts', 'en-US', { name: 'Mute', eventTypes: ['end'] }),
      voice('chrome-tts', '', { name: 'NoLang' }),
    ];
    expect(toVoiceInfos(mixed)).toEqual([
      { name: 'A', lang: 'en-US', engine: 'chrome-tts', remote: false },
      { name: 'NoLang', engine: 'chrome-tts', remote: false },
    ]);
  });
});

describe('toPlatform', () => {
  it('maps the browser os names', () => {
    for (const os of ['linux', 'mac', 'win', 'cros', 'android']) expect(toPlatform(os)).toBe(os);
    for (const os of ['openbsd', 'fuchsia', '', undefined]) expect(toPlatform(os)).toBe('other');
  });
});
