import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  registerOffscreenSpeech,
  type OffscreenPageDeps,
  type SynthLike,
  type SynthUtteranceLike,
  type SynthVoiceLike,
} from '../../../lib/speech/offscreen-page';
import { ID_A } from './helpers';

const WORKER_URL = 'chrome-extension://ext/background.js';
type Listener = Parameters<OffscreenPageDeps['runtime']['onMessage']['addListener']>[0];

function makePage(
  initialVoices: SynthVoiceLike[],
  opts: { synth?: boolean; workerUrl?: string | undefined } = {},
) {
  let voices = initialVoices;
  const voiceListeners = new Set<() => void>();
  const spoken: SynthUtteranceLike[] = [];
  const synth: SynthLike = {
    getVoices: () => voices,
    speak: (u) => {
      spoken.push(u);
    },
    cancel: vi.fn(),
    addEventListener: (_t, l) => {
      voiceListeners.add(l);
    },
    removeEventListener: (_t, l) => {
      voiceListeners.delete(l);
    },
  };
  let listener: Listener | undefined;
  const sent: { type?: string; state?: string; detail?: string }[] = [];
  registerOffscreenSpeech({
    runtime: {
      id: 'ext',
      sendMessage: (m) => {
        sent.push(m as never);
        return Promise.resolve();
      },
      onMessage: { addListener: (l) => (listener = l) },
    },
    workerUrl: 'workerUrl' in opts ? opts.workerUrl : WORKER_URL,
    synth: opts.synth === false ? undefined : synth,
    createUtterance: (text) => ({
      text,
      lang: '',
      rate: 1,
      voice: null,
      onstart: null,
      onend: null,
      onerror: null,
    }),
    voicesLoadTimeoutMs: 1_000,
    idleNotifyMs: 10_000,
  });

  async function command(
    message: unknown,
    sender: { id?: string; tab?: unknown; url?: string } = { id: 'ext', url: WORKER_URL },
  ) {
    let reply: unknown;
    const done = new Promise<void>((resolve) => {
      const keepOpen = listener?.(message, sender, (r) => {
        reply = r;
        resolve();
      });
      if (keepOpen !== true) resolve();
    });
    await vi.advanceTimersByTimeAsync(0);
    return {
      settle: async (ms = 0) => {
        await vi.advanceTimersByTimeAsync(ms);
        await done;
        return reply;
      },
    };
  }

  return {
    command,
    sent,
    spoken,
    synth,
    setVoices: (v: SynthVoiceLike[]) => {
      voices = v;
      for (const l of [...voiceListeners]) l();
    },
  };
}

const EN: SynthVoiceLike = { name: 'Local', lang: 'en-US', localService: true };
const FR: SynthVoiceLike = { name: 'Remote', lang: 'fr-FR', localService: false };
const GET = { v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_GET_VOICES' };
const speakCmd = (over: object = {}) => ({
  v: 1,
  target: 'offscreen',
  type: 'SPEECH_OFFSCREEN_SPEAK',
  requestId: ID_A,
  text: 'bank',
  lang: 'en-US',
  rate: 1,
  ...over,
});

describe('offscreen page', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports voices immediately when the list is already loaded', async () => {
    const page = makePage([EN, FR]);
    const reply = await (await page.command(GET)).settle();
    expect(reply).toEqual({
      ok: true,
      supported: true,
      voices: [
        { name: 'Local', lang: 'en-US', remote: false },
        { name: 'Remote', lang: 'fr-FR', remote: true },
      ],
    });
  });

  it('waits for voiceschanged when the list loads asynchronously', async () => {
    const page = makePage([]);
    const pending = await page.command(GET);
    await vi.advanceTimersByTimeAsync(200);
    page.setVoices([EN]);
    expect(await pending.settle()).toMatchObject({ voices: [{ name: 'Local' }] });
  });

  it('gives up after the timeout and reports an empty list (Linux without speech-dispatcher)', async () => {
    const page = makePage([]);
    const reply = await (await page.command(GET)).settle(1_000);
    expect(reply).toEqual({ ok: true, supported: true, voices: [] });
  });

  it('does not wait again once an empty list has already timed out', async () => {
    const page = makePage([]);
    await (await page.command(GET)).settle(1_000);
    const second = await page.command(GET);
    // No timer advance beyond a microtask flush: it must already be answered.
    expect(await second.settle(0)).toEqual({ ok: true, supported: true, voices: [] });
  });

  it('reports supported:false when the page has no speechSynthesis', async () => {
    const page = makePage([], { synth: false });
    expect(await (await page.command(GET)).settle()).toEqual({
      ok: true,
      supported: false,
      voices: [],
    });
  });

  it('refuses to speak when no voice qualifies instead of pretending', async () => {
    const page = makePage([FR]);
    const reply = await (await page.command(speakCmd({ lang: 'en-US' }))).settle();
    expect(reply).toMatchObject({ ok: false });
    expect(page.spoken).toHaveLength(0);
  });

  it('speaks with the chosen voice, language and rate, cancelling earlier speech first', async () => {
    const page = makePage([EN, FR]);
    const reply = await (await page.command(speakCmd({ voiceName: 'Local', rate: 0.75 }))).settle();
    expect(reply).toEqual({ ok: true });
    expect(page.synth.cancel).toHaveBeenCalled();
    const [utterance] = page.spoken;
    expect(utterance).toMatchObject({ text: 'bank', lang: 'en-US', rate: 0.75, voice: EN });
  });

  it('relays start and end events to the background', async () => {
    const page = makePage([EN]);
    await (await page.command(speakCmd())).settle();
    const utterance = page.spoken[0] as SynthUtteranceLike;
    utterance.onstart?.();
    utterance.onend?.();
    expect(
      page.sent.filter((m) => m.type === 'SPEECH_OFFSCREEN_EVENT').map((m) => m.state),
    ).toEqual(['started', 'ended']);
  });

  it.each([
    ['canceled', 'cancelled', undefined],
    ['interrupted', 'cancelled', undefined],
    ['synthesis-failed', 'error', 'synthesis-failed'],
  ])('maps speechSynthesis error "%s" to %s', async (reason, state, detail) => {
    const page = makePage([EN]);
    await (await page.command(speakCmd())).settle();
    (page.spoken[0] as SynthUtteranceLike).onerror?.({ error: reason });
    const event = page.sent.find((m) => m.type === 'SPEECH_OFFSCREEN_EVENT');
    expect(event?.state).toBe(state);
    expect(event?.detail).toBe(detail);
  });

  it('stop cancels speech and acknowledges', async () => {
    const page = makePage([EN]);
    const reply = await (
      await page.command({ v: 1, target: 'offscreen', type: 'SPEECH_OFFSCREEN_STOP' })
    ).settle();
    expect(reply).toEqual({ ok: true });
    expect(page.synth.cancel).toHaveBeenCalled();
  });

  it('only obeys the service worker: no tab, this extension and the worker script url (INFO-9)', async () => {
    const page = makePage([EN]);
    const refused: { id?: string; tab?: unknown; url?: string }[] = [
      // A content script (tab) that borrowed the extension id.
      { id: 'ext', tab: { id: 1 }, url: 'https://evil.example/' },
      // Another extension.
      { id: 'other', url: WORKER_URL },
      // Our own tab-less popup, and our own pages in a tab: not the worker.
      { id: 'ext', url: 'chrome-extension://ext/popup.html' },
      { id: 'ext', tab: { id: 2 }, url: 'chrome-extension://ext/options.html' },
      { id: 'ext', url: 'chrome-extension://ext/offscreen.html' },
      // The worker's url but with a tab, or no url at all.
      { id: 'ext', tab: { id: 3 }, url: WORKER_URL },
      { id: 'ext' },
      { id: 'ext', url: `${WORKER_URL}?x=1` },
    ];
    for (const sender of refused) {
      expect(await (await page.command(GET, sender)).settle()).toBeUndefined();
      expect(await (await page.command(speakCmd(), sender)).settle()).toBeUndefined();
    }
    expect(page.spoken).toHaveLength(0);
    // The worker itself is heard.
    expect(await (await page.command(GET)).settle()).toMatchObject({ ok: true });
  });

  it('fails closed when the worker url is unknown', async () => {
    const page = makePage([EN], { workerUrl: undefined });
    expect(await (await page.command(GET)).settle()).toBeUndefined();
  });

  it('speaks the voice it was told by name, and refuses (no stand-in) when it is missing', async () => {
    const page = makePage([EN, FR]);
    expect(
      await (await page.command(speakCmd({ voiceName: 'Remote', lang: 'fr-FR' }))).settle(),
    ).toEqual({
      ok: true,
    });
    expect(page.spoken[0]?.voice?.name).toBe('Remote');
    const missing = await (await page.command(speakCmd({ voiceName: 'Gone' }))).settle();
    expect(missing).toMatchObject({ ok: false });
    expect(page.spoken).toHaveLength(1);
  });

  it('reports only voices that can be addressed by name, and a bounded list', async () => {
    const odd: SynthVoiceLike[] = [
      { name: '', lang: 'en', localService: true },
      { name: 'x'.repeat(129), lang: 'en', localService: true },
      EN,
    ];
    const page = makePage(odd);
    expect(await (await page.command(GET)).settle()).toMatchObject({
      voices: [{ name: 'Local', lang: 'en-US', remote: false }],
    });
  });

  it('ignores messages that are not addressed to it, and rejects malformed commands', async () => {
    const page = makePage([EN]);
    expect(await (await page.command({ v: 1, type: 'TTS_SPEAK' })).settle()).toBeUndefined();
    expect(await (await page.command('hello')).settle()).toBeUndefined();
    const bad = await (await page.command(speakCmd({ rate: 99 }))).settle();
    expect(bad).toMatchObject({ ok: false });
    expect(page.spoken).toHaveLength(0);
  });

  it('tells the background it is idle after its own timeout, not while speaking', async () => {
    const page = makePage([EN]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.sent.some((m) => m.type === 'SPEECH_OFFSCREEN_IDLE')).toBe(true);
    page.sent.length = 0;
    await (await page.command(speakCmd())).settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(page.sent.some((m) => m.type === 'SPEECH_OFFSCREEN_IDLE')).toBe(false);
  });
});
