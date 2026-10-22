import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS, TTS_RATES } from '../../../lib/config/constants';
import { SpeechService, normalizeRate } from '../../../lib/speech/service';
import { SpeechError, type SpeechStateEvent } from '../../../lib/speech/types';
import { FakeEngine, ID_A, ID_B, voice } from './helpers';

function setup(
  chromeVoices = [voice('chrome-tts', 'en-US')],
  offscreenVoices = [voice('offscreen-web-speech', 'en-US')],
) {
  const chrome = new FakeEngine('chrome-tts', chromeVoices);
  const offscreen = new FakeEngine('offscreen-web-speech', offscreenVoices);
  const service = new SpeechService({ engines: [chrome, offscreen], startTimeoutMs: 1_000 });
  const events: SpeechStateEvent[] = [];
  service.onState((event) => events.push(event));
  return { chrome, offscreen, service, events };
}

const input = (
  over: Partial<{ requestId: string; text: string; lang: string; rate: number }> = {},
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

describe('routing order (D-07)', () => {
  it('uses chrome.tts when it has a suitable voice and never touches the offscreen engine', async () => {
    const { chrome, offscreen, service } = setup();
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result).toMatchObject({
      engine: 'chrome-tts',
      requestId: ID_A,
      voiceName: 'chrome-tts-en-US',
    });
    expect(chrome.speakCalls).toHaveLength(1);
    expect(offscreen.getVoicesCalls).toHaveLength(0);
    expect(offscreen.speakCalls).toHaveLength(0);
  });

  it('falls back to the offscreen engine when chrome.tts has no voices', async () => {
    const { chrome, offscreen, service } = setup([], [voice('offscreen-web-speech', 'en-US')]);
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result.engine).toBe('offscreen-web-speech');
    expect(chrome.speakCalls).toHaveLength(0);
    expect(offscreen.speakCalls[0]?.voice?.name).toBe('offscreen-web-speech-en-US');
  });

  it('falls back when chrome.tts has voices but none for the requested language', async () => {
    const { service } = setup(
      [voice('chrome-tts', 'de-DE')],
      [voice('offscreen-web-speech', 'en-GB')],
    );
    const result = await service.speak(input({ lang: 'en-US' }));
    expect(result.engine).toBe('offscreen-web-speech');
  });

  it('treats a chrome.tts that throws on getVoices as unavailable', async () => {
    const { chrome, service } = setup();
    chrome.getVoicesError = new Error('tts permission missing');
    const result = await service.speak(input());
    expect(result.engine).toBe('offscreen-web-speech');
  });

  it('returns NO_VOICE when no engine has any voice (never a fake success)', async () => {
    const { chrome, offscreen, service, events } = setup([], []);
    const error = await rejection(service.speak(input()));
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechNoVoice');
    expect(chrome.speakCalls).toHaveLength(0);
    expect(offscreen.speakCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('returns NO_VOICE when both engines throw while listing voices', async () => {
    const { chrome, offscreen, service } = setup();
    chrome.getVoicesError = new Error('a');
    offscreen.getVoicesError = new Error('b');
    expect((await rejection(service.speak(input()))).code).toBe('NO_VOICE');
  });

  it('explains a language gap separately from having no voice at all', async () => {
    const { service } = setup([voice('chrome-tts', 'en-US')], []);
    const error = await rejection(service.speak(input({ lang: 'fr-FR' })));
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechNoVoiceForLanguage');
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

  it('stop() cancels the tracked utterance and stops every engine', async () => {
    const { chrome, offscreen, service, events } = setup();
    await service.speak(input());
    await expect(service.stop()).resolves.toBe(true);
    expect(events.map((e) => e.state)).toEqual(['started', 'cancelled']);
    expect(chrome.stopCalls).toBeGreaterThan(0);
    expect(offscreen.stopCalls).toBe(1);
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
    const { chrome, offscreen, service, events } = setup([voice('chrome-tts', 'en-US')], []);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(999);
    expect(service.activeRequestId).toBe(ID_A);
    await vi.advanceTimersByTimeAsync(1);
    const error = await pending;
    expect(error.code).toBe('NO_VOICE');
    expect(error.messageKey).toBe('speechStartFailed');
    expect(chrome.stopCalls).toBeGreaterThan(0);
    expect(offscreen.speakCalls).toHaveLength(0);
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('falls through to the offscreen engine after a chrome.tts start timeout', async () => {
    const { chrome, service } = setup();
    chrome.autoStart = false;
    const pending = service.speak(input());
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(pending).resolves.toMatchObject({ engine: 'offscreen-web-speech' });
  });

  it('ignores a start event that arrives after the timeout gave up', async () => {
    const { chrome, service, events } = setup([voice('chrome-tts', 'en-US')], []);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(1_000);
    await pending;
    chrome.emit({ state: 'started' });
    expect(events).toEqual([]);
    expect(service.activeRequestId).toBeUndefined();
  });

  it('treats an error before start (what chrome.tts does with no voice) as failure, not playback', async () => {
    const { chrome, service, events } = setup([voice('chrome-tts', 'en-US')], []);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(0);
    chrome.emit({ state: 'error' });
    expect((await pending).code).toBe('NO_VOICE');
    expect(events).toEqual([]);
  });

  it('treats ended-without-start as failure (no audio was proven)', async () => {
    const { chrome, service } = setup([voice('chrome-tts', 'en-US')], []);
    chrome.autoStart = false;
    const pending = rejection(service.speak(input()));
    await vi.advanceTimersByTimeAsync(0);
    chrome.emit({ state: 'ended' });
    expect((await pending).code).toBe('NO_VOICE');
  });

  it('fails when the engine rejects while dispatching', async () => {
    const { chrome, service } = setup([voice('chrome-tts', 'en-US')], []);
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

describe('capability', () => {
  it('reports chrome-tts and does not probe the offscreen engine when chrome.tts has voices', async () => {
    const { offscreen, service } = setup();
    const capability = await service.getCapability();
    expect(capability.engine).toBe('chrome-tts');
    expect(capability.voices).toHaveLength(1);
    expect(capability.probes).toEqual([{ engine: 'chrome-tts', voiceCount: 1 }]);
    expect(offscreen.getVoicesCalls).toHaveLength(0);
  });

  it('reports the offscreen engine when only it has voices', async () => {
    const { service } = setup([], [voice('offscreen-web-speech', 'en-US')]);
    const capability = await service.getCapability();
    expect(capability.engine).toBe('offscreen-web-speech');
    expect(capability.probes.map((p) => p.voiceCount)).toEqual([0, 1]);
  });

  it('reports none with both probes when nothing exists, and records probe errors', async () => {
    const { offscreen, service } = setup([], []);
    offscreen.getVoicesError = new Error('document creation failed');
    const capability = await service.getCapability();
    expect(capability).toEqual({
      engine: 'none',
      voices: [],
      probes: [
        { engine: 'chrome-tts', voiceCount: 0 },
        { engine: 'offscreen-web-speech', voiceCount: 0, error: 'document creation failed' },
      ],
    });
  });

  it('probeAll also queries engines after the first with voices (diagnostics)', async () => {
    const { service } = setup();
    const capability = await service.getCapability({ probeAll: true });
    expect(capability.engine).toBe('chrome-tts');
    expect(capability.probes).toHaveLength(2);
  });

  it('getVoices returns the routed engine voices', async () => {
    const { service } = setup([], [voice('offscreen-web-speech', 'fr-FR')]);
    expect((await service.getVoices()).map((v) => v.lang)).toEqual(['fr-FR']);
  });
});
