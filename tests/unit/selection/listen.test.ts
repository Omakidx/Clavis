import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MESSAGE_VERSION } from '../../../lib/config/constants';
import {
  createListenController,
  LISTEN_START_TIMEOUT_MS,
  listenRate,
} from '../../../lib/selection/listen';
import type { ListenReport, RunContext } from '../../../lib/selection/ui-api';

// The content-side Listen state machine: TTS_SPEAK / TTS_STOP / TTS_EVENT.

const REQUEST_ID = '2d8a3a8e-0c1b-4d63-a1de-0f6a9f6f3a11';

const snapshot = {
  selectionId: '5f1c2a3b-0c1b-4d63-a1de-0f6a9f6f3a99',
  source: 'webpage' as const,
  kind: 'sentence' as const,
  text: 'She finally broke the ice.',
  contextBefore: 'Everyone was quiet at first. ',
  contextAfter: ' Then they all laughed.',
  languageHint: 'en',
};

type Reply = unknown | (() => Promise<unknown>);

/** A background stand-in: preferences, a TTS_SPEAK answer the test controls, and a log. */
function setup(options: { speak?: Reply; prefs?: Record<string, unknown> } = {}) {
  const sent: Array<Record<string, unknown>> = [];
  let speakReply: Reply =
    'speak' in options
      ? options.speak
      : { ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } };
  const send = vi.fn((message: unknown): Promise<unknown> => {
    const m = message as Record<string, unknown>;
    sent.push(m);
    if (m['type'] === 'GET_PUBLIC_SETTINGS') {
      return Promise.resolve({
        ok: true,
        data: { ttsRate: 1, explanationLanguage: 'en', ...options.prefs },
      });
    }
    if (m['type'] === 'TTS_SPEAK') {
      return typeof speakReply === 'function'
        ? (speakReply as () => Promise<unknown>)()
        : Promise.resolve(speakReply);
    }
    return Promise.resolve({ ok: true, data: { stopped: true } });
  });
  const controller = createListenController({ send, newId: () => REQUEST_ID });
  const reports: ListenReport[] = [];
  const mirrored: ListenReport[] = [];
  const abort = new AbortController();
  const context = (slow?: boolean): RunContext => ({
    snapshot,
    overLimit: false,
    signal: abort.signal,
    listen: { slow, report: (r) => reports.push(r) },
  });
  return {
    controller,
    sent,
    reports,
    mirrored,
    abort,
    context,
    setSpeak: (reply: Reply) => (speakReply = reply),
    of: (type: string) => sent.filter((m) => m['type'] === type),
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);
const event = (state: string, requestId = REQUEST_ID) => ({
  v: MESSAGE_VERSION,
  type: 'TTS_EVENT',
  requestId,
  state,
});

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('listen controller', () => {
  it('uses a known translation language before the general speech locale and keeps saved speed', async () => {
    const h = setup({ prefs: { ttsLang: 'en-US', ttsRate: 1.25 } });
    const context = h.context();
    context.listen!.lang = 'fr';
    h.controller.listen(context);
    await flush();
    expect(h.of('TTS_SPEAK')[0]).toMatchObject({ lang: 'fr', rate: 1.25, text: snapshot.text });
    expect(h.of('TTS_SPEAK')[0]).not.toHaveProperty('voiceName');
  });

  it('reports starting at once, and playing only after the started reply', async () => {
    let answer: (value: unknown) => void = () => undefined;
    const h = setup({ speak: () => new Promise((resolve) => (answer = resolve)) });
    h.controller.listen(h.context());
    expect(h.reports).toEqual([{ status: 'starting' }]);
    await flush();
    // TTS_SPEAK is out but unanswered: still nothing playing.
    expect(h.of('TTS_SPEAK')).toHaveLength(1);
    expect(h.reports).toEqual([{ status: 'starting' }]);

    answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
    await flush();
    expect(h.reports.at(-1)).toEqual({ status: 'playing', slow: false, remote: false });
  });

  it('sends only the selected text (never the context), the preference rate and language', async () => {
    const h = setup({ prefs: { ttsRate: 1.25, ttsLang: 'fr' } });
    h.controller.listen(h.context());
    await flush();
    const speak = h.of('TTS_SPEAK')[0] as Record<string, unknown>;
    expect(speak).toEqual({
      v: MESSAGE_VERSION,
      type: 'TTS_SPEAK',
      requestId: REQUEST_ID,
      text: 'She finally broke the ice.',
      rate: 1.25,
      lang: 'fr',
    });
    expect(JSON.stringify(speak)).not.toContain('Everyone was quiet');
    expect(JSON.stringify(speak)).not.toContain('laughed');
  });

  it('falls back to the page language hint, and to defaults when preferences do not answer', async () => {
    const h = setup();
    h.controller.listen(h.context());
    await flush();
    expect(h.of('TTS_SPEAK')[0]).toMatchObject({ lang: 'en', rate: 1 });

    const silent = createListenController({
      send: vi.fn((m: unknown) =>
        Promise.resolve(
          (m as { type: string }).type === 'TTS_SPEAK'
            ? { ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } }
            : undefined,
        ),
      ),
      newId: () => REQUEST_ID,
    });
    const reports: ListenReport[] = [];
    silent.listen({
      snapshot: { ...snapshot, languageHint: undefined } as never,
      overLimit: false,
      signal: new AbortController().signal,
      listen: { slow: undefined, report: (r) => reports.push(r) },
    });
    await flush();
    expect(reports.at(-1)).toMatchObject({ status: 'playing', slow: false });
  });

  describe('speed', () => {
    it('listenRate: no choice keeps the preference; Slow is 0.75; Normal is 1 unless the preference is faster', () => {
      expect(listenRate(undefined, 0.75)).toBe(0.75);
      expect(listenRate(undefined, 1.5)).toBe(1.5);
      expect(listenRate(true, 1.5)).toBe(0.75);
      expect(listenRate(false, 0.75)).toBe(1);
      expect(listenRate(false, 1.5)).toBe(1.5);
    });

    it('a Slow preference makes the first playback slow and reports it', async () => {
      const h = setup({ prefs: { ttsRate: 0.75 } });
      h.controller.listen(h.context());
      await flush();
      expect(h.of('TTS_SPEAK')[0]).toMatchObject({ rate: 0.75 });
      expect(h.reports.at(-1)).toEqual({ status: 'playing', slow: true, remote: false });
    });

    it('the toolbar choice beats the preference in both directions', async () => {
      const slow = setup({ prefs: { ttsRate: 1 } });
      slow.controller.listen(slow.context(true));
      await flush();
      expect(slow.of('TTS_SPEAK')[0]).toMatchObject({ rate: 0.75 });

      const normal = setup({ prefs: { ttsRate: 0.75 } });
      normal.controller.listen(normal.context(false));
      await flush();
      expect(normal.of('TTS_SPEAK')[0]).toMatchObject({ rate: 1 });
      expect(normal.reports.at(-1)).toMatchObject({ status: 'playing', slow: false });
    });
  });

  describe('playback events', () => {
    it.each([
      ['ended', { status: 'ended' }],
      ['cancelled', { status: 'ended' }],
      ['error', { status: 'ended', message: 'speechPlaybackError' }],
    ])('TTS_EVENT %s ends playing', async (state, expected) => {
      const h = setup();
      h.controller.listen(h.context());
      await flush();
      expect(h.controller.handleEvent(event(state))).toBe(true);
      expect(h.reports.at(-1)).toEqual(expected);
    });

    it('ignores events for other requests and malformed messages', async () => {
      const h = setup();
      h.controller.listen(h.context());
      await flush();
      expect(h.controller.handleEvent(event('ended', 'other-request'))).toBe(false);
      expect(h.controller.handleEvent({ type: 'TTS_EVENT', requestId: REQUEST_ID })).toBe(false);
      expect(h.controller.handleEvent({ ...event('ended'), v: 99 })).toBe(false);
      expect(h.controller.handleEvent('nope')).toBe(false);
      expect(h.controller.handleEvent(null)).toBe(false);
      expect(h.reports.at(-1)).toMatchObject({ status: 'playing' });
    });

    it('an event that overtakes the started reply ends the run without a fake playing state', async () => {
      let answer: (value: unknown) => void = () => undefined;
      const h = setup({ speak: () => new Promise((resolve) => (answer = resolve)) });
      h.controller.listen(h.context());
      await flush();
      h.controller.handleEvent(event('ended'));
      expect(h.reports).toEqual([{ status: 'starting' }]);
      answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
      await flush();
      expect(h.reports.at(-1)).toEqual({ status: 'ended' });
      expect(h.reports.some((r) => r.status === 'playing')).toBe(false);
    });

    it('reports a remote voice', async () => {
      const h = setup({
        speak: { ok: true, data: { state: 'started', engine: 'chrome-tts', remote: true } },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({ status: 'playing', slow: false, remote: true });
    });
  });

  describe('stopping', () => {
    it('aborting while playing sends TTS_STOP for this request and stops reporting', async () => {
      const h = setup();
      h.controller.listen(h.context());
      await flush();
      h.abort.abort();
      expect(h.of('TTS_STOP')).toEqual([
        { v: MESSAGE_VERSION, type: 'TTS_STOP', requestId: REQUEST_ID },
      ]);
      // The background's follow-up event does not resurrect any state.
      const before = h.reports.length;
      h.controller.handleEvent(event('cancelled'));
      expect(h.reports).toHaveLength(before);
    });

    it('aborting before TTS_SPEAK went out sends nothing at all', async () => {
      const h = setup();
      h.controller.listen(h.context());
      h.abort.abort();
      await flush();
      expect(h.of('TTS_SPEAK')).toHaveLength(0);
      expect(h.of('TTS_STOP')).toHaveLength(0);
    });

    it('aborting while the reply is pending stops a late start', async () => {
      let answer: (value: unknown) => void = () => undefined;
      const h = setup({ speak: () => new Promise((resolve) => (answer = resolve)) });
      h.controller.listen(h.context());
      await flush();
      h.abort.abort();
      expect(h.of('TTS_STOP')).toHaveLength(1);
      answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
      await flush();
      expect(h.reports.some((r) => r.status === 'playing')).toBe(false);
      // The late start is stopped again, so no audio is left running.
      expect(h.of('TTS_STOP').length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('starting backstop', () => {
    it('sits above the background deadline (~5 s)', () => {
      expect(LISTEN_START_TIMEOUT_MS).toBe(7000);
    });

    it('gives up after the timeout with a message, and stops a late start', async () => {
      let answer: (value: unknown) => void = () => undefined;
      const h = setup({ speak: () => new Promise((resolve) => (answer = resolve)) });
      h.controller.listen(h.context());
      await flush();
      await vi.advanceTimersByTimeAsync(LISTEN_START_TIMEOUT_MS - 1);
      expect(h.reports).toEqual([{ status: 'starting' }]);
      await vi.advanceTimersByTimeAsync(1);
      expect(h.reports.at(-1)).toEqual({ status: 'failed', message: 'speechTimedOut' });
      expect(h.of('TTS_STOP')).toHaveLength(1);

      answer({ ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } });
      await flush();
      expect(h.reports.some((r) => r.status === 'playing')).toBe(false);
    });

    it('does not fire once playing', async () => {
      const h = setup();
      h.controller.listen(h.context());
      await flush();
      await vi.advanceTimersByTimeAsync(LISTEN_START_TIMEOUT_MS * 2);
      expect(h.reports.at(-1)).toMatchObject({ status: 'playing' });
    });
  });

  describe('failures', () => {
    it('NO_VOICE with the Linux reason adds the Linux hint', async () => {
      const h = setup({
        speak: { ok: false, error: { code: 'NO_VOICE', message: 'x', reason: 'no-voice-linux' } },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({
        status: 'unavailable',
        message: 'speechNoVoice',
        hint: 'speechNoVoiceLinuxHint',
      });
    });

    it('NO_VOICE without a reason gets the generic hint', async () => {
      const h = setup({ speak: { ok: false, error: { code: 'NO_VOICE', message: 'x' } } });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({
        status: 'unavailable',
        message: 'speechNoVoice',
        hint: 'speechNoVoiceHint',
      });
    });

    it.each([
      [{ ok: false, error: { code: 'INVALID_REQUEST', message: 'x' } }, 'speechInvalidRequest'],
      [{ ok: false, error: { code: 'SELECTION_TOO_LONG', message: 'x' } }, 'speechInvalidRequest'],
      [{ ok: false, error: { code: 'TIMEOUT', message: 'x' } }, 'speechTimedOut'],
      [{ ok: false, error: { code: 'INTERNAL_ERROR', message: 'x' } }, 'toolbarActionFailed'],
      [null, 'errNoResponse'],
      [{ ok: true, data: { state: 'queued' } }, 'errInvalidResponse'],
      ['garbage', 'errInvalidResponse'],
    ])('maps %j to a failed state, never to playing', async (reply, message) => {
      const h = setup({ speak: reply });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toMatchObject({ status: 'failed', message });
      expect(h.reports.some((r) => r.status === 'playing')).toBe(false);
    });

    it('a cancelled reply (superseded elsewhere, nothing ever played) goes back to idle, not Replay', async () => {
      const h = setup({ speak: { ok: false, error: { code: 'REQUEST_CANCELLED', message: 'x' } } });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({ status: 'idle' });
    });

    it('NO_VOICE for the language: its own message, no install hint', async () => {
      const h = setup({
        speak: {
          ok: false,
          error: { code: 'NO_VOICE', message: 'x', reason: 'no-voice-language' },
        },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({
        status: 'unavailable',
        message: 'speechNoVoiceForLanguage',
      });
    });

    it('NO_VOICE with online-only offers Voice settings and no install hint', async () => {
      const h = setup({
        speak: { ok: false, error: { code: 'NO_VOICE', message: 'x', reason: 'online-only' } },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({ status: 'unavailable', message: 'speechOnlineOnly' });
    });

    it('NO_VOICE with start-failed is a failure (retry), not "no voice", with no install hint', async () => {
      const h = setup({
        speak: { ok: false, error: { code: 'NO_VOICE', message: 'x', reason: 'start-failed' } },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({ status: 'failed', message: 'speechStartFailed' });
    });

    it('an unknown NO_VOICE reason gets the generic copy', async () => {
      const h = setup({
        speak: { ok: false, error: { code: 'NO_VOICE', message: 'x', reason: 'something-new' } },
      });
      h.controller.listen(h.context());
      await flush();
      expect(h.reports.at(-1)).toEqual({
        status: 'unavailable',
        message: 'speechNoVoice',
        hint: 'speechNoVoiceHint',
      });
    });

    it('a rejected send (worker gone) is a failure, not a hang', async () => {
      const controller = createListenController({
        send: () => Promise.reject(new Error('Extension context invalidated')),
        newId: () => REQUEST_ID,
      });
      const reports: ListenReport[] = [];
      controller.listen({
        snapshot,
        overLimit: false,
        signal: new AbortController().signal,
        listen: { slow: undefined, report: (r) => reports.push(r) },
      });
      await flush();
      expect(reports.at(-1)).toMatchObject({ status: 'failed' });
    });
  });

  it('mirrors every report, including the idle after a stop, to an observer', async () => {
    const onReport = vi.fn();
    const send = vi.fn((m: unknown) =>
      Promise.resolve(
        (m as { type: string }).type === 'TTS_SPEAK'
          ? { ok: true, data: { state: 'started', engine: 'chrome-tts', remote: false } }
          : { ok: true, data: {} },
      ),
    );
    const controller = createListenController({ send, newId: () => REQUEST_ID, onReport });
    const abort = new AbortController();
    controller.listen({
      snapshot,
      overLimit: false,
      signal: abort.signal,
      listen: { slow: undefined, report: () => undefined },
    });
    await flush();
    abort.abort();
    expect(onReport.mock.calls.map(([r]) => (r as ListenReport).status)).toEqual([
      'starting',
      'playing',
      'idle',
    ]);
  });

  it('openVoiceSettings asks for the voice section of Settings', async () => {
    const h = setup();
    h.controller.openVoiceSettings();
    await flush();
    expect(h.of('OPEN_SETTINGS')).toEqual([
      { v: MESSAGE_VERSION, type: 'OPEN_SETTINGS', section: 'voice' },
    ]);
  });
});
