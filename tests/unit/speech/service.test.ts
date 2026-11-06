import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, TTS_RATES } from '../../../lib/config/constants';
import { SpeechService, normalizeRate } from '../../../lib/speech/service';
import { SpeechError, type SpeechStateEvent } from '../../../lib/speech/types';
import { FakeEngine, ID_A, ID_B, voice } from './helpers';

function setup(chromeVoices = [voice('chrome-tts', 'en-US')]) {
  const chrome = new FakeEngine('chrome-tts', chromeVoices);
  const service = new SpeechService({ engine: chrome, startTimeoutMs: 1_000 });
  const events: SpeechStateEvent[] = [];
  service.onState((event) => events.push(event));
  return { chrome, service, events };
}

const input = (
  over: Partial<{
    requestId: string;
    text: string;
    lang: string;
    rate: number;
    voiceName: string;
    preferredVoice: string;
  }> = {},
) => ({
  requestId: ID_A,
  text: 'bank',
  rate: 1,
  ...over,
});

async function rejection(promise: Promise<unknown>): Promise<SpeechError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SpeechError);
    return error as SpeechError;
  }
  throw new Error('expected rejection');
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('voice availability', () => {
  it('speaks with chrome.tts when it has a suitable voice', async () => {
    const { chrome, service } = setup();
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result).toMatchObject({
      engine: 'chrome-tts',
      requestId: ID_A,
      voiceName: 'chrome-tts-en-US',
    });
    expect(chrome.speakCalls).toHaveLength(1);
  });

  it('treats a chrome.tts that throws on getVoices as no voice', async () => {
    const { chrome, service } = setup();
    chrome.getVoicesError = new Error('tts permission missing');
    expect((await rejection(service.speak(input()))).noVoice).toBe('no-voices');
  });

  it('returns NO_VOICE when there is no voice at all (never a fake success)', async () => {
    const { chrome, service, events } = setup([]);
    const error = await rejection(service.speak(input()));
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechNoVoice');
    expect(chrome.speakCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('explains a language gap separately from having no voice at all', async () => {
    const { service } = setup([voice('chrome-tts', 'en-US')]);
    const error = await rejection(service.speak(input({ lang: 'fr-FR' })));
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechNoVoiceForLanguage');
    expect(error.noVoice).toBe('no-language-match');
  });
});

describe('validation', () => {
  it('clamps out-of-range rates into the supported range', () => {
    expect(normalizeRate(0.1)).toBe(TTS_RATES.min);
    expect(normalizeRate(99)).toBe(TTS_RATES.max);
    expect(normalizeRate(TTS_RATES.slow)).toBe(TTS_RATES.slow);
  });

  it('rejects non-finite rates', () => {
    expect(() => normalizeRate(Number.NaN)).toThrow(SpeechError);
    expect(() => normalizeRate(Number.POSITIVE_INFINITY)).toThrow(SpeechError);
  });

  it('passes the clamped rate and trimmed text to the engine', async () => {
    const { chrome, service } = setup();
    await service.speak(input({ text: '  bank  ', rate: 50 }));
    expect(chrome.speakCalls[0]).toMatchObject({ text: 'bank', rate: TTS_RATES.max });
  });

  it('rejects empty text without probing any engine', async () => {
    const { chrome, service } = setup();
    const error = await rejection(service.speak(input({ text: '   ' })));
    expect(error.messageKey).toBe('speechInvalidRequest');
    expect(chrome.getVoicesCalls).toHaveLength(0);
  });

  it('rejects text over the selection limit with SELECTION_TOO_LONG', async () => {
    const { service } = setup();
    const error = await rejection(
      service.speak(input({ text: 'x'.repeat(LIMITS.maxSelectionChars + 1) })),
    );
    expect(error.code).toBe('SELECTION_TOO_LONG');
    // The limit itself is allowed.
    await expect(
      service.speak(input({ text: 'x'.repeat(LIMITS.maxSelectionChars) })),
    ).resolves.toBeDefined();
  });
});

describe('state events', () => {
  it('maps started, ended in order and clears the active request', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input());
    expect(service.activeRequestId).toBe(ID_A);
    chrome.emit({ state: 'ended' });
    expect(events.map((e) => [e.requestId, e.state, e.engine])).toEqual([
      [ID_A, 'started', 'chrome-tts'],
      [ID_A, 'ended', 'chrome-tts'],
    ]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('reports an error after start with its detail, once', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input());
    chrome.emit({ state: 'error', detail: 'synthesis-failed' });
    chrome.emit({ state: 'ended' });
    expect(events.map((e) => e.state)).toEqual(['started', 'error']);
    expect(events[1]?.detail).toBe('synthesis-failed');
  });

  it('reports cancelled when the engine interrupts the utterance', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input());
    chrome.emit({ state: 'cancelled' });
    expect(events.map((e) => e.state)).toEqual(['started', 'cancelled']);
  });

  it('survives a throwing listener', async () => {
    const { chrome, service, events } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    service.onState(() => {
      throw new Error('boom');
    });
    await service.speak(input());
    chrome.emit({ state: 'ended' });
    expect(events.map((e) => e.state)).toEqual(['started', 'ended']);
  });

  it('stops notifying an unsubscribed listener', async () => {
    const { service } = setup();
    const seen: string[] = [];
    const off = service.onState((e) => seen.push(e.state));
    off();
    await service.speak(input());
    expect(seen).toEqual([]);
  });
});

describe('one utterance at a time', () => {
  it('stops the previous utterance and reports it cancelled when a new one starts', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input({ requestId: ID_A }));
    const stopsBefore = chrome.stopCalls;
    await service.speak(input({ requestId: ID_B, text: 'river' }));

    expect(chrome.stopCalls).toBeGreaterThan(stopsBefore);
    expect(events.map((e) => `${e.requestId === ID_A ? 'A' : 'B'}:${e.state}`)).toEqual([
      'A:started',
      'A:cancelled',
      'B:started',
    ]);
    expect(service.activeRequestId).toBe(ID_B);
  });

  it('ignores the late interrupted event the old utterance still delivers', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input({ requestId: ID_A }));
    await service.speak(input({ requestId: ID_B }));
    // chrome.tts delivers `interrupted` for A after B started; A is already settled.
    chrome.emit({ state: 'cancelled' }, 0);
    chrome.emit({ state: 'ended' }, 0);
    expect(events.filter((e) => e.requestId === ID_A).map((e) => e.state)).toEqual([
      'started',
      'cancelled',
    ]);
    expect(service.activeRequestId).toBe(ID_B);
  });

  it('cancels a speak that is still starting when a newer one arrives', async () => {
    const { chrome, service } = setup();
    chrome.autoStart = false;
    const first = service.speak(input({ requestId: ID_A }));
    const firstFailure = rejection(first);
    await vi.advanceTimersByTimeAsync(0);
    chrome.autoStart = true;
    const second = service.speak(input({ requestId: ID_B }));
    expect((await firstFailure).code).toBe('REQUEST_CANCELLED');
    await expect(second).resolves.toMatchObject({ requestId: ID_B });
  });

  it('cancels a speak that is still looking up voices when a newer one arrives', async () => {
    const { chrome, service } = setup();
    // Nothing is known yet, and the (late-loading) voice list is still coming.
    let release: (() => void) | undefined;
    chrome.getVoices = () =>
      new Promise((resolve) => {
        release = () => resolve([voice('chrome-tts', 'en-US')]);
      });
    const first = rejection(service.speak(input({ requestId: ID_A })));
    await vi.advanceTimersByTimeAsync(0);
    chrome.getVoices = () => Promise.resolve([voice('chrome-tts', 'en-US')]);
    const second = service.speak(input({ requestId: ID_B }));
    release?.();
    expect((await first).code).toBe('REQUEST_CANCELLED');
    await expect(second).resolves.toMatchObject({ requestId: ID_B });
    expect(chrome.speakCalls.map((c) => c.requestId)).toEqual([ID_B]);
  });

  it('stop() cancels the tracked utterance and stops the engine', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input());
    await expect(service.stop()).resolves.toBe(true);
    expect(events.map((e) => e.state)).toEqual(['started', 'cancelled']);
    expect(chrome.stopCalls).toBeGreaterThan(0);
  });

  it('stop() with nothing tracked still stops engines (speech left over from a restarted worker)', async () => {
    const { chrome, service } = setup();
    await expect(service.stop()).resolves.toBe(false);
    expect(chrome.stopCalls).toBe(1);
  });

  it('a stale stop(requestId) does not cut off a newer utterance', async () => {
    const { chrome, service, events } = setup();
    await service.speak(input({ requestId: ID_B }));
    const stops = chrome.stopCalls;
    await expect(service.stop(ID_A)).resolves.toBe(false);
    expect(chrome.stopCalls).toBe(stops);
    expect(events.map((e) => e.state)).toEqual(['started']);
    await expect(service.stop(ID_B)).resolves.toBe(true);
  });

  it('stop() while an utterance is still starting rejects it as cancelled', async () => {
    const { chrome, service } = setup();
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(0);
    await service.stop(ID_A);
    expect((await pending).code).toBe('REQUEST_CANCELLED');
  });
});

describe('"supported but no audio" handling', () => {
  it('fails with NO_VOICE when no start event arrives in time, and stops the engine', async () => {
    const { chrome, service, events } = setup([voice('chrome-tts', 'en-US')]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(999);
    expect(service.activeRequestId).toBe(ID_A);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechStartFailed');
    expect(chrome.stopCalls).toBeGreaterThan(0);
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('tries one more voice when the first never starts, and reports the one that spoke', async () => {
    const a = voice('chrome-tts', 'en-US', { name: 'A' });
    const b = voice('chrome-tts', 'en-GB', { name: 'B' });
    const { chrome, service } = setup([a, b]);
    // Only the first attempt stays silent.
    const speak = chrome.speak.bind(chrome);
    chrome.autoStart = false;
    chrome.speak = (request, sink) => {
      if (chrome.speakCalls.length >= 1) chrome.autoStart = true;
      return speak(request, sink);
    };
    const pending = service.speak(input({ lang: 'en' }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ voiceName: 'B' });
    expect(chrome.speakCalls.map((c) => c.voice?.name)).toEqual(['A', 'B']);
  });

  it('gives up after two voices that do not start (no endless tour of the voice list)', async () => {
    const many = ['A', 'B', 'C', 'D'].map((name) => voice('chrome-tts', 'en-US', { name }));
    const { chrome, service } = setup(many);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(2_100);
    expect((await pending).noVoice).toBe('start-failed');
    expect(chrome.speakCalls).toHaveLength(2);
  });

  it('ignores a start event that arrives after the timeout gave up', async () => {
    const { chrome, service, events } = setup([voice('chrome-tts', 'en-US')]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    chrome.emit({ state: 'started' });
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('treats an error before start (what chrome.tts does with no voice) as failure, not playback', async () => {
    const { chrome, service, events } = setup([voice('chrome-tts', 'en-US')]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(0);
    chrome.emit({ state: 'error' });
    expect((await pending).code).toBe('NO_VOICE');
    expect(events).toEqual([]);
  });

  it('treats ended-without-start as failure (no audio was proven)', async () => {
    const { chrome, service } = setup([voice('chrome-tts', 'en-US')]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(0);
    chrome.emit({ state: 'ended' });
    expect((await pending).code).toBe('NO_VOICE');
  });

  it('fails when the engine rejects while dispatching', async () => {
    const { chrome, service } = setup([voice('chrome-tts', 'en-US')]);
    chrome.speakError = new Error('Invalid voice');
    expect((await rejection(service.speak(input()))).code).toBe('NO_VOICE');
  });

  it('cancels the start timer once speech has started', async () => {
    const { service, events } = setup();
    await service.speak(input());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events.map((e) => e.state)).toEqual(['started']);
    expect(service.activeRequestId).toBe(ID_A);
  });
});

describe('voice choice: explicit voice, saved voice, best match (FR-024, FR-025)', () => {
  const alex = voice('chrome-tts', 'en-US', { name: 'Alex' });
  const daniel = voice('chrome-tts', 'en-GB', { name: 'Daniel' });
  const amelie = voice('chrome-tts', 'fr-FR', { name: 'Amelie' });

  it('an explicit voiceName speaks with exactly that voice and its own language tag', async () => {
    const { chrome, service } = setup([alex, daniel, amelie]);
    const result = await service.speak(input({ voiceName: 'Daniel', lang: 'en' }));
    expect(result).toMatchObject({ voiceName: 'Daniel', lang: 'en-GB', engine: 'chrome-tts' });
    expect(chrome.speakCalls[0]?.voice?.name).toBe('Daniel');
    expect(chrome.speakCalls[0]?.lang).toBe('en-GB');
  });

  it('an explicit voice that exists nowhere is NO_VOICE, never another voice', async () => {
    const { chrome, service } = setup([alex, daniel]);
    const error = await rejection(service.speak(input({ voiceName: 'Gone', lang: 'en-US' })));
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechNoVoiceForLanguage');
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('an explicit voice that never starts fails; it does not fall back to a match', async () => {
    const { chrome, service } = setup([alex, daniel]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ voiceName: 'Daniel' })));
    await vi.advanceTimersByTimeAsync(1_100);
    const error = await pending;
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechStartFailed');
    expect(chrome.speakCalls.map((c) => c.voice?.name)).toEqual(['Daniel']);
  });

  it('an explicit voice with no voices installed at all is the plain no-voice error', async () => {
    const { service } = setup([]);
    const pending = rejection(service.speak(input({ voiceName: 'Alex' })));
    await vi.advanceTimersByTimeAsync(10);
    expect((await pending).messageKey).toBe('speechNoVoice');
  });

  it('the saved voice is used when it still exists and speaks the language', async () => {
    const { service } = setup([alex, daniel]);
    const result = await service.speak(input({ preferredVoice: 'Daniel', lang: 'en-US' }));
    expect(result.voiceName).toBe('Daniel');
    const without = await service.speak(input({ requestId: ID_B, lang: 'en-US' }));
    expect(without.voiceName).toBe('Alex');
  });

  it('the saved voice is used when no language is known', async () => {
    const { service } = setup([alex, amelie]);
    expect((await service.speak(input({ preferredVoice: 'Amelie' }))).voiceName).toBe('Amelie');
  });

  it('a saved voice that disappeared falls back to the best match, and the reply says which', async () => {
    const { service } = setup([alex, daniel]);
    const result = await service.speak(input({ preferredVoice: 'Removed', lang: 'en-GB' }));
    expect(result.voiceName).toBe('Daniel');
  });

  it('a saved voice for another language never reads text in this language', async () => {
    const { chrome, service } = setup([alex, amelie]);
    const result = await service.speak(input({ preferredVoice: 'Alex', lang: 'fr' }));
    expect(result.voiceName).toBe('Amelie');
    expect(chrome.speakCalls[0]?.voice?.name).toBe('Amelie');
  });

  it('with only voices of other languages the answer is no-voice-for-language (no stand-in)', async () => {
    const { chrome, service } = setup([alex]);
    const error = await rejection(service.speak(input({ preferredVoice: 'Alex', lang: 'de' })));
    expect(error.messageKey).toBe('speechNoVoiceForLanguage');
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('a saved voice that does not start falls back to the best match', async () => {
    const { chrome, service } = setup([alex, daniel]);
    // Only the first attempt (the saved voice) stays silent.
    const speak = chrome.speak.bind(chrome);
    chrome.autoStart = false;
    chrome.speak = (request, sink) => {
      if (chrome.speakCalls.length >= 1) chrome.autoStart = true;
      return speak(request, sink);
    };
    const pending = service.speak(input({ preferredVoice: 'Daniel', lang: 'en' }));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await pending).toMatchObject({ voiceName: 'Alex', engine: 'chrome-tts' });
    expect(chrome.speakCalls.map((c) => c.voice?.name)).toEqual(['Daniel', 'Alex']);
  });

  it('never speaks a voice name the engine did not list (no invented voices)', async () => {
    const { chrome, service } = setup([alex]);
    await service.speak(input({ voiceName: 'Alex' }));
    expect(chrome.speakCalls[0]?.voice).toEqual(alex);
  });
});

describe('no-voice answers are remembered by the engine; the service forwards changes', () => {
  it('asks the engine once per request and never waits beyond its own voice wait', async () => {
    const { chrome, service } = setup([]);
    chrome.getVoicesDelayMs = 1_500;
    const started = Date.now();
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await pending).messageKey).toBe('speechNoVoice');
    expect(Date.now() - started).toBe(1_500);
    expect(chrome.getVoicesCalls).toHaveLength(1);
  });

  it('invalidateVoices asks the engine to forget a remembered answer', () => {
    const { chrome, service } = setup();
    service.invalidateVoices();
    expect(chrome.invalidateCalls).toBe(1);
  });

  it('a platform voices-changed event invalidates (speech-dispatcher installed)', () => {
    const chrome = new FakeEngine('chrome-tts', []);
    let changed: () => void = () => undefined;
    new SpeechService({
      engine: chrome,
      watchVoiceChanges: (listener) => {
        changed = listener;
      },
    });
    expect(chrome.invalidateCalls).toBe(0);
    changed();
    expect(chrome.invalidateCalls).toBe(1);
  });
});

describe('listVoices (Settings voice report)', () => {
  it('asks the engine for fresh voices', async () => {
    const { chrome, service } = setup([voice('chrome-tts', 'en-US')]);
    expect(await service.listVoices()).toEqual([voice('chrome-tts', 'en-US')]);
    expect(chrome.refreshCalls).toEqual([true]);
  });

  it('never rejects: an engine that throws has no voices', async () => {
    const { chrome, service } = setup();
    chrome.getVoicesError = new Error('tts unavailable');
    expect(await service.listVoices()).toEqual([]);
  });
});

describe('a Stop never loses the race against a speak that is still starting (H1)', () => {
  it('stop(requestId) during the voice lookup cancels it, and no audio starts', async () => {
    const { chrome, service } = setup([]);
    chrome.getVoicesDelayMs = 1_500;
    chrome.voices = [voice('chrome-tts', 'en-US')];
    const speaking = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(100);
    expect(service.trackedRequestId).toBe(ID_A);
    expect(await service.stop(ID_A)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await speaking).code).toBe('REQUEST_CANCELLED');
    expect(chrome.speakCalls).toHaveLength(0);
    expect(service.trackedRequestId).toBeUndefined();
  });

  it('an id-less stop during the lookup cancels it too', async () => {
    const { chrome, service } = setup([]);
    chrome.getVoicesDelayMs = 1_500;
    chrome.voices = [voice('chrome-tts', 'en-US')];
    const speaking = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(100);
    expect(await service.stop()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await speaking).code).toBe('REQUEST_CANCELLED');
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('a stop between two attempts (the first failed, the next not yet started) ends the request', async () => {
    const a = voice('chrome-tts', 'en-US', { name: 'A' });
    const b = voice('chrome-tts', 'en-GB', { name: 'B' });
    const { chrome, service } = setup([a, b]);
    chrome.autoStart = false;
    const speaking = rejection(service.speak(input({ lang: 'en' })));
    // The first voice times out at 1 s and the second attempt begins at once; stop it there.
    await vi.advanceTimersByTimeAsync(1_100);
    expect(service.trackedRequestId).toBe(ID_A);
    expect(await service.stop(ID_A)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect((await speaking).code).toBe('REQUEST_CANCELLED');
    expect(service.trackedRequestId).toBeUndefined();
  });

  it('a stale stop for another id still does nothing while a request is starting', async () => {
    const { chrome, service } = setup([]);
    chrome.getVoicesDelayMs = 500;
    chrome.voices = [voice('chrome-tts', 'en-US')];
    const speaking = service.speak(input({ lang: 'en' }));
    await vi.advanceTimersByTimeAsync(10);
    expect(await service.stop(ID_B)).toBe(false);
    await vi.advanceTimersByTimeAsync(600);
    await expect(speaking).resolves.toMatchObject({ requestId: ID_A });
  });
});

describe('one overall start deadline (M3)', () => {
  it('lookup and attempts share the budget: a slow lookup leaves less time for the attempt', async () => {
    const chrome = new FakeEngine('chrome-tts', []);
    chrome.voices = [voice('chrome-tts', 'en-US')];
    chrome.getVoicesDelayMs = 3_000;
    chrome.autoStart = false;
    const service = new SpeechService({
      engine: chrome,
      startTimeoutMs: 5_000,
      speakDeadlineMs: 5_000,
    });
    const started = Date.now();
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(5_000);
    const error = await pending;
    expect(error.noVoice).toBe('start-failed');
    expect(Date.now() - started).toBe(5_000);
  });

  it('two failing voices cannot add up beyond the deadline', async () => {
    const { chrome, service } = setup([
      voice('chrome-tts', 'en-US', { name: 'A' }),
      voice('chrome-tts', 'en-GB', { name: 'B' }),
    ]);
    chrome.autoStart = false;
    const started = Date.now();
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).noVoice).toBe('start-failed');
    expect(Date.now() - started).toBeLessThanOrEqual(5_000);
    expect(chrome.speakCalls).toHaveLength(2);
  });

  it('gives the second attempt only what is left of the budget', async () => {
    const chrome = new FakeEngine('chrome-tts', [
      voice('chrome-tts', 'en-US', { name: 'A' }),
      voice('chrome-tts', 'en-GB', { name: 'B' }),
    ]);
    chrome.autoStart = false;
    const service = new SpeechService({
      engine: chrome,
      startTimeoutMs: 4_000,
      speakDeadlineMs: 5_000,
    });
    const started = Date.now();
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    // 4 s for the first attempt + the remaining 1 s for the second, not 8 s.
    expect(Date.now() - started).toBe(5_000);
    expect(chrome.speakCalls).toHaveLength(2);
  });

  it('does not try the voice that already failed again in the best-match loop', async () => {
    const alex = voice('chrome-tts', 'en-US', { name: 'Alex' });
    const { chrome, service } = setup([alex]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ preferredVoice: 'Alex', lang: 'en' })));
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;
    expect(chrome.speakCalls.map((c) => c.voice?.name)).toEqual(['Alex']);
  });
});

describe('Automatic local-first voice choice with matching online fallback', () => {
  const local = voice('chrome-tts', 'en-US', { name: 'Local' });
  const net = voice('chrome-tts', 'en-US', { name: 'Net', remote: true });

  it('uses a local same-language voice before an online exact-locale voice', async () => {
    const localOtherRegion = voice('chrome-tts', 'en-GB', { name: 'Local GB' });
    const { chrome, service } = setup([net, localOtherRegion]);
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result).toMatchObject({ voiceName: 'Local GB', remote: false });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local GB']);
  });

  it('best match starts local even when an online voice is listed first', async () => {
    const { chrome, service } = setup([net, local]);
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result).toMatchObject({ voiceName: 'Local', remote: false });
    expect(chrome.speakCalls[0]?.voice?.name).toBe('Local');
  });

  it('uses a matching online voice when no local one is available', async () => {
    const { chrome, service } = setup([net]);
    expect(await service.speak(input({ lang: 'en' }))).toMatchObject({
      voiceName: 'Net',
      remote: true,
    });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Net']);
  });

  it('skips a local voice that cannot report start and uses a matching online voice', async () => {
    const unusableLocal = voice('chrome-tts', 'en-US', {
      name: 'Silent local',
      eventTypes: ['end', 'error'],
    });
    const { chrome, service } = setup([unusableLocal, net]);
    expect(await service.speak(input({ lang: 'en' }))).toMatchObject({
      voiceName: 'Net',
      remote: true,
    });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Net']);
  });

  it('uses the second attempt for online after the local voice fails to start', async () => {
    const secondLocal = voice('chrome-tts', 'en-US', { name: 'Local 2' });
    const { chrome, service } = setup([local, secondLocal, net]);
    const speak = chrome.speak.bind(chrome);
    chrome.autoStart = false;
    chrome.speak = (request, sink) => {
      if (chrome.speakCalls.length >= 1) chrome.autoStart = true;
      return speak(request, sink);
    };
    const pending = service.speak(input({ lang: 'en' }));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toMatchObject({ voiceName: 'Net', remote: true });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local', 'Net']);
  });

  it('at default timings, a silent local voice leaves time for online fallback', async () => {
    const chrome = new FakeEngine('chrome-tts', [local, net]);
    const service = new SpeechService({ engine: chrome });
    const speak = chrome.speak.bind(chrome);
    chrome.autoStart = false;
    chrome.speak = (request, sink) => {
      if (chrome.speakCalls.length >= 1) chrome.autoStart = true;
      return speak(request, sink);
    };
    const started = Date.now();
    const pending = service.speak(input({ lang: 'en' }));
    await vi.advanceTimersByTimeAsync(2_499);
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local']);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ voiceName: 'Net', remote: true });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local', 'Net']);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('gives a saved local voice the same online fallback budget', async () => {
    const chrome = new FakeEngine('chrome-tts', [local, net]);
    const service = new SpeechService({ engine: chrome });
    const speak = chrome.speak.bind(chrome);
    chrome.autoStart = false;
    chrome.speak = (request, sink) => {
      if (chrome.speakCalls.length >= 1) chrome.autoStart = true;
      return speak(request, sink);
    };
    const pending = service.speak(input({ preferredVoice: 'Local', lang: 'en' }));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await pending).toMatchObject({ voiceName: 'Net', remote: true });
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local', 'Net']);
  });

  it('never starts a saved local voice when lookup consumes the entire deadline', async () => {
    const chrome = new FakeEngine('chrome-tts', [local, net]);
    const started = Date.now();
    chrome.getVoices = () =>
      Promise.resolve().then(() => {
        // The voice list arrives exactly as the overall deadline expires.
        vi.setSystemTime(started + 5_000);
        return [local, net];
      });
    const service = new SpeechService({ engine: chrome });
    const error = await rejection(service.speak(input({ preferredVoice: 'Local', lang: 'en' })));
    expect(error.code).toBe('NO_VOICE');
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it('keeps the full startup budget for an explicit local voice', async () => {
    const chrome = new FakeEngine('chrome-tts', [local, net]);
    const service = new SpeechService({ engine: chrome });
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ voiceName: 'Local', lang: 'en' })));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local']);
    await vi.advanceTimersByTimeAsync(2_500);
    expect((await pending).noVoice).toBe('start-failed');
    expect(chrome.speakCalls).toHaveLength(1);
  });

  it('caps two silent local and online attempts at the original overall deadline', async () => {
    const chrome = new FakeEngine('chrome-tts', [local, net]);
    const service = new SpeechService({ engine: chrome });
    chrome.autoStart = false;
    const started = Date.now();
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).noVoice).toBe('start-failed');
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local', 'Net']);
    expect(Date.now() - started).toBe(5_000);
  });

  it('stop during the online fallback cancels it without a third attempt', async () => {
    const { chrome, service } = setup([local, net]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(1_100);
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local', 'Net']);
    expect(await service.stop(ID_A)).toBe(true);
    expect((await pending).code).toBe('REQUEST_CANCELLED');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(chrome.speakCalls).toHaveLength(2);
  });

  it('a cancelled local start never falls back online', async () => {
    const { chrome, service } = setup([local, net]);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input({ lang: 'en' })));
    await vi.advanceTimersByTimeAsync(0);
    await service.stop(ID_A);
    expect((await pending).code).toBe('REQUEST_CANCELLED');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(chrome.speakCalls.map((call) => call.voice?.name)).toEqual(['Local']);
  });

  it('network voices for another language only are a plain language gap', async () => {
    const { chrome, service } = setup([
      voice('chrome-tts', 'fr-FR', { name: 'Net', remote: true }),
    ]);
    expect((await rejection(service.speak(input({ lang: 'en' })))).noVoice).toBe(
      'no-language-match',
    );
    expect(chrome.speakCalls).toHaveLength(0);
  });

  it("a saved or explicit network voice is the user's choice and is used", async () => {
    const { service } = setup([net, local]);
    expect(await service.speak(input({ preferredVoice: 'Net', lang: 'en' }))).toMatchObject({
      voiceName: 'Net',
      remote: true,
    });
    expect(await service.speak(input({ requestId: ID_B, voiceName: 'Net' }))).toMatchObject({
      voiceName: 'Net',
      remote: true,
    });
  });

  it('without a language: an on-device voice of the system language, else the first one', async () => {
    const de = voice('chrome-tts', 'de-DE', { name: 'Hans' });
    const fr = voice('chrome-tts', 'fr-FR', { name: 'Amelie' });
    const chrome = new FakeEngine('chrome-tts', [net, de, fr]);
    const withSystem = new SpeechService({ engine: chrome, defaultLanguage: 'fr-CA' });
    expect((await withSystem.speak(input())).voiceName).toBe('Amelie');
    const without = new SpeechService({ engine: chrome });
    expect((await without.speak(input({ requestId: ID_B }))).voiceName).toBe('Hans');
  });

  it('without a language and with only online voices: chooses one explicitly', async () => {
    const { chrome, service } = setup([net]);
    expect(await service.speak(input())).toMatchObject({ voiceName: 'Net', remote: true });
    expect(chrome.speakCalls[0]?.voice?.name).toBe('Net');
  });
});

describe('saved voice details', () => {
  it('a saved voice that reports no language is accepted for any text language (L6)', async () => {
    const unlabelled = voice('chrome-tts', '', { name: 'Mystery' });
    const { chrome, service } = setup([unlabelled, voice('chrome-tts', 'en-US', { name: 'Alex' })]);
    const result = await service.speak(input({ preferredVoice: 'Mystery', lang: 'fr' }));
    expect(result.voiceName).toBe('Mystery');
    expect(chrome.speakCalls[0]?.voice?.name).toBe('Mystery');
    // A voice that does report another language is still refused.
    const refused = await rejection(
      setupFor([voice('chrome-tts', 'en-US', { name: 'Alex' })]).speak(
        input({ requestId: ID_B, preferredVoice: 'Alex', lang: 'fr' }),
      ),
    );
    expect(refused.noVoice).toBe('no-language-match');
  });
});

function setupFor(voices: ReturnType<typeof voice>[]): SpeechService {
  return new SpeechService({
    engine: new FakeEngine('chrome-tts', voices),
    startTimeoutMs: 1_000,
  });
}
