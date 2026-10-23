import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChromeTtsEngine, mapTtsEvent, type TtsApi } from '../../../lib/speech/engines/chrome-tts';
import type { EngineEvent } from '../../../lib/speech/types';
import { ID_A, voice } from './helpers';

describe('mapTtsEvent', () => {
  it.each([
    ['start', { state: 'started' }],
    ['end', { state: 'ended' }],
    ['interrupted', { state: 'cancelled' }],
    ['cancelled', { state: 'cancelled' }],
    ['error', { state: 'error', detail: 'chrome.tts reported an error' }],
  ])('maps %s', (type, expected) => {
    expect(mapTtsEvent(type)).toEqual(expected);
  });

  it('carries the engine error message', () => {
    expect(mapTtsEvent('error', 'Voice not found')).toEqual({
      state: 'error',
      detail: 'Voice not found',
    });
  });

  it.each(['word', 'sentence', 'marker', 'pause', 'resume'])('ignores %s', (type) => {
    expect(mapTtsEvent(type)).toBeUndefined();
  });
});

function fakeTts() {
  const calls: string[] = [];
  let options: Parameters<TtsApi['speak']>[1] | undefined;
  const tts: TtsApi = {
    getVoices: vi.fn(() =>
      Promise.resolve([
        { voiceName: 'Alice', lang: 'en-US', remote: false, eventTypes: ['start', 'end'] },
        { lang: 'fr-FR', remote: true },
      ]),
    ),
    speak: vi.fn((_text, opts) => {
      calls.push('speak');
      options = opts;
      return Promise.resolve();
    }),
    stop: vi.fn(() => {
      calls.push('stop');
    }),
  };
  return { tts, calls, options: () => options };
}

describe('ChromeTtsEngine', () => {
  it('maps chrome.tts voices to Clavis voices', async () => {
    const engine = new ChromeTtsEngine(fakeTts().tts);
    expect(await engine.getVoices()).toEqual([
      {
        name: 'Alice',
        lang: 'en-US',
        remote: false,
        engine: 'chrome-tts',
        eventTypes: ['start', 'end'],
      },
      { name: '', lang: 'fr-FR', remote: true, engine: 'chrome-tts', eventTypes: undefined },
    ]);
  });

  it('stops first, then speaks with enqueue:false, the chosen voice, language and rate', async () => {
    const { tts, calls, options } = fakeTts();
    const engine = new ChromeTtsEngine(tts);
    await engine.speak(
      {
        requestId: ID_A,
        text: 'bank',
        lang: 'en-US',
        rate: 0.75,
        voice: voice('chrome-tts', 'en-US'),
      },
      () => undefined,
    );
    expect(calls).toEqual(['stop', 'speak']);
    expect(tts.speak).toHaveBeenCalledWith('bank', expect.objectContaining({ enqueue: false }));
    expect(options()).toMatchObject({
      lang: 'en-US',
      voiceName: 'chrome-tts-en-US',
      rate: 0.75,
      enqueue: false,
    });
  });

  it('omits language and voice when none was requested so the engine default applies', async () => {
    const { tts, options } = fakeTts();
    await new ChromeTtsEngine(tts).speak(
      { requestId: ID_A, text: 'bank', rate: 1 },
      () => undefined,
    );
    expect(options()).not.toHaveProperty('lang');
    expect(options()).not.toHaveProperty('voiceName');
  });

  it('forwards mapped events and drops word/sentence noise', async () => {
    const { tts, options } = fakeTts();
    const seen: EngineEvent[] = [];
    await new ChromeTtsEngine(tts).speak({ requestId: ID_A, text: 'bank', rate: 1 }, (e) =>
      seen.push(e),
    );
    for (const type of ['start', 'word', 'sentence', 'end']) options()?.onEvent({ type });
    expect(seen.map((e) => e.state)).toEqual(['started', 'ended']);
  });

  it('propagates a rejected speak() so the service can fail the attempt', async () => {
    const { tts } = fakeTts();
    vi.mocked(tts.speak).mockRejectedValueOnce(new Error('Invalid lang'));
    await expect(
      new ChromeTtsEngine(tts).speak({ requestId: ID_A, text: 'x', rate: 1 }, () => undefined),
    ).rejects.toThrow('Invalid lang');
  });

  it('stop() calls chrome.tts.stop', async () => {
    const { tts } = fakeTts();
    await new ChromeTtsEngine(tts).stop();
    expect(tts.stop).toHaveBeenCalledTimes(1);
  });
});

describe('ChromeTtsEngine: voices that load late (speech-dispatcher on Linux)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function lateTts(lists: { voiceName: string; lang: string }[][]) {
    const listeners = new Set<() => void>();
    const { tts } = fakeTts();
    const queue = [...lists];
    tts.getVoices = vi.fn(() =>
      Promise.resolve(queue.length > 1 ? (queue.shift() ?? []) : (queue[0] ?? [])),
    );
    tts.onVoicesChanged = {
      addListener: (cb) => listeners.add(cb),
      removeListener: (cb) => listeners.delete(cb),
    };
    return { tts, fire: () => [...listeners].forEach((cb) => cb()), listeners };
  }

  it('re-queries after onVoicesChanged when the first answer is empty', async () => {
    const { tts, fire } = lateTts([[], [{ voiceName: 'espeak', lang: 'en' }]]);
    const pending = new ChromeTtsEngine(tts, 1_000).getVoices();
    await vi.advanceTimersByTimeAsync(100);
    fire();
    expect((await pending).map((v) => v.name)).toEqual(['espeak']);
  });

  it('gives up after the timeout and reports no voices, without leaking the listener', async () => {
    const { tts, listeners } = lateTts([[]]);
    const pending = new ChromeTtsEngine(tts, 1_000).getVoices();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toEqual([]);
    expect(listeners.size).toBe(0);
  });

  it('does not make every later request wait once an empty list timed out', async () => {
    const { tts } = lateTts([[]]);
    const engine = new ChromeTtsEngine(tts, 1_000);
    const first = engine.getVoices();
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    await expect(engine.getVoices()).resolves.toEqual([]);
  });

  it('does not wait at all when voices are present or onVoicesChanged does not exist', async () => {
    const present = lateTts([[{ voiceName: 'a', lang: 'en' }]]);
    await expect(new ChromeTtsEngine(present.tts, 1_000).getVoices()).resolves.toHaveLength(1);
    const { tts } = fakeTts();
    tts.getVoices = vi.fn(() => Promise.resolve([]));
    await expect(new ChromeTtsEngine(tts, 1_000).getVoices()).resolves.toEqual([]);
  });
});

describe('ChromeTtsEngine: remembered empty answer, peek and invalidate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function emptyTts() {
    const listeners = new Set<() => void>();
    const { tts } = fakeTts();
    let voices: { voiceName: string; lang: string }[] = [];
    tts.getVoices = vi.fn(() => Promise.resolve(voices));
    tts.onVoicesChanged = {
      addListener: (cb) => listeners.add(cb),
      removeListener: (cb) => listeners.delete(cb),
    };
    return { tts, setVoices: (next: typeof voices) => (voices = next) };
  }

  it('invalidate() makes the next empty answer wait and look again (voices installed later)', async () => {
    const { tts, setVoices } = emptyTts();
    const engine = new ChromeTtsEngine(tts, 1_000);
    const first = engine.getVoices();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toEqual([]);
    // Remembered: no wait now, even though voices appeared in the meantime.
    setVoices([{ voiceName: 'espeak', lang: 'en' }]);
    engine.invalidate();
    expect((await engine.getVoices()).map((v) => v.name)).toEqual(['espeak']);
  });

  it('refresh: true forgets the remembered answer and waits again', async () => {
    const { tts } = emptyTts();
    const engine = new ChromeTtsEngine(tts, 1_000);
    const first = engine.getVoices();
    await vi.advanceTimersByTimeAsync(1_000);
    await first;
    const refreshed = engine.getVoices({ refresh: true });
    let settled = false;
    void refreshed.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await refreshed).toEqual([]);
  });
});
