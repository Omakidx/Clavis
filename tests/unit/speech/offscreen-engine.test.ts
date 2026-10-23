import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffscreenSpeechEngine } from '../../../lib/speech/engines/offscreen';
import type { OffscreenHost } from '../../../lib/speech/offscreen-host';
import type { EngineEvent } from '../../../lib/speech/types';
import { ID_A, ID_B } from './helpers';

function makeHost() {
  let open = false;
  const sent: { type?: string }[] = [];
  const host: OffscreenHost & { sent: typeof sent; closes: number; creates: number } = {
    sent,
    closes: 0,
    creates: 0,
    hasDocument: () => Promise.resolve(open),
    ensureDocument: () => {
      if (!open) host.creates++;
      open = true;
      return Promise.resolve();
    },
    closeDocument: () => {
      if (open) host.closes++;
      open = false;
      return Promise.resolve();
    },
    send: vi.fn((message: unknown) => {
      sent.push(message as { type?: string });
      const type = (message as { type?: string }).type;
      if (type === 'SPEECH_OFFSCREEN_GET_VOICES') {
        return Promise.resolve({
          ok: true,
          supported: true,
          voices: [{ name: 'Test', lang: 'en-US', remote: false }],
        });
      }
      return Promise.resolve({ ok: true });
    }),
  };
  return host;
}

const IDLE = 5_000;
const request = (requestId = ID_A) => ({ requestId, text: 'bank', rate: 1, lang: 'en-US' });

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('OffscreenSpeechEngine', () => {
  it('lists voices from the offscreen page, tagged with the engine', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    expect(await engine.getVoices()).toEqual([
      { name: 'Test', lang: 'en-US', remote: false, engine: 'offscreen-web-speech' },
    ]);
    expect(host.creates).toBe(1);
  });

  it('rejects an unexpected voice reply instead of trusting it', async () => {
    const host = makeHost();
    vi.mocked(host.send).mockResolvedValueOnce({ nonsense: true });
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await expect(engine.getVoices()).rejects.toThrow();
  });

  it('sends the speak command with voice name, language and rate', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(
      {
        ...request(),
        rate: 0.75,
        voice: { name: 'Test', lang: 'en-US', remote: false, engine: 'offscreen-web-speech' },
      },
      () => undefined,
    );
    expect(host.sent.at(-1)).toMatchObject({
      type: 'SPEECH_OFFSCREEN_SPEAK',
      requestId: ID_A,
      text: 'bank',
      lang: 'en-US',
      voiceName: 'Test',
      rate: 0.75,
      target: 'offscreen',
    });
  });

  it('fails speak() when the page refuses, so the service can report NO_VOICE', async () => {
    const host = makeHost();
    vi.mocked(host.send).mockResolvedValueOnce({ ok: false, detail: 'No usable voice' });
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await expect(engine.speak(request(), () => undefined)).rejects.toThrow('No usable voice');
  });

  it('relays page events for the current request only', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    const seen: EngineEvent[] = [];
    await engine.speak(request(ID_A), (event) => seen.push(event));
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_B,
      state: 'started',
    });
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'started',
    });
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'error',
      detail: 'synthesis-failed',
    });
    expect(seen).toEqual([{ state: 'started' }, { state: 'error', detail: 'synthesis-failed' }]);
  });

  it('closes the document after the idle timeout once speech ended', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(), () => undefined);
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'started',
    });
    await vi.advanceTimersByTimeAsync(IDLE * 3);
    expect(host.closes).toBe(0); // still speaking: never closed mid-utterance

    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'ended',
    });
    await vi.advanceTimersByTimeAsync(IDLE - 1);
    expect(host.closes).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(host.closes).toBe(1);
  });

  it('postpones the idle close when a new utterance starts, then reuses the same document', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(ID_A), () => undefined);
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'ended',
    });
    await vi.advanceTimersByTimeAsync(IDLE - 10);
    await engine.speak(request(ID_B), () => undefined);
    await vi.advanceTimersByTimeAsync(IDLE - 10);
    expect(host.closes).toBe(0);
    expect(host.creates).toBe(1);
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_B,
      state: 'cancelled',
    });
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(host.closes).toBe(1);
  });

  it('closes an idle document that was only created to probe voices', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.getVoices();
    await vi.advanceTimersByTimeAsync(IDLE);
    expect(host.closes).toBe(1);
  });

  it('recreates the document on the next request after an idle close', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.getVoices();
    await vi.advanceTimersByTimeAsync(IDLE);
    await engine.getVoices();
    expect(host.creates).toBe(2);
  });

  it('stop() never creates a document and does nothing when none exists', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.stop();
    expect(host.creates).toBe(0);
    expect(host.sent).toHaveLength(0);
  });

  it('stop() tells an existing page to stop', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(), () => undefined);
    await engine.stop();
    expect(host.sent.at(-1)?.type).toBe('SPEECH_OFFSCREEN_STOP');
  });

  it("closes on the page's own idle notice, but not while speaking", async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(), () => undefined);
    engine.handlePageIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.closes).toBe(0);
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_A,
      state: 'ended',
    });
    engine.handlePageIdle();
    await vi.advanceTimersByTimeAsync(0);
    expect(host.closes).toBe(1);
  });

  it('survives a failing close', async () => {
    const host = makeHost();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    host.closeDocument = () => Promise.reject(new Error('already closed'));
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await expect(engine.closeNow()).resolves.toBeUndefined();
  });
});

describe('OffscreenSpeechEngine: remembered no-voice, survey, bounded probe', () => {
  function emptyHost(supported = true) {
    const host = makeHost();
    host.send = vi.fn((message: unknown) => {
      host.sent.push(message as { type?: string });
      return Promise.resolve(
        (message as { type?: string }).type === 'SPEECH_OFFSCREEN_GET_VOICES'
          ? { ok: true, supported, voices: [] }
          : { ok: true },
      );
    });
    return host;
  }

  it('remembers an empty answer: no document, no wait, until invalidated', async () => {
    const host = emptyHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    expect(await engine.getVoices()).toEqual([]);
    expect(host.creates).toBe(1);
    // Nothing to speak with: the document is not kept around for the idle period.
    expect(host.closes).toBe(1);
    expect(await engine.getVoices()).toEqual([]);
    expect(host.creates).toBe(1);
    engine.invalidate();
    await engine.getVoices();
    expect(host.creates).toBe(2);
  });

  it('refresh: true probes again', async () => {
    const host = emptyHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.getVoices();
    await engine.getVoices({ refresh: true });
    expect(host.sent.filter((m) => m.type === 'SPEECH_OFFSCREEN_GET_VOICES')).toHaveLength(2);
  });

  it('does not remember a failed probe (the document may start next time)', async () => {
    const host = makeHost();
    const original = host.ensureDocument;
    host.ensureDocument = vi.fn().mockRejectedValueOnce(new Error('boom'));
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await expect(engine.getVoices()).rejects.toThrow('boom');
    host.ensureDocument = original;
    expect(await engine.getVoices()).toHaveLength(1);
  });

  it('gives up on a document that never answers, within the probe bound', async () => {
    const host = makeHost();
    host.send = vi.fn(() => new Promise<never>(() => undefined));
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE, probeTimeoutMs: 4_000 });
    const pending = expect(engine.getVoices()).rejects.toThrow(/did not answer in time/);
    await vi.advanceTimersByTimeAsync(4_000);
    await pending;
  });

  it('survey creates the document only for the probe and closes it again', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    expect(await engine.survey()).toEqual({
      available: true,
      voices: [{ name: 'Test', lang: 'en-US', remote: false, engine: 'offscreen-web-speech' }],
    });
    expect(host.creates).toBe(1);
    expect(host.closes).toBe(1);
    expect(await host.hasDocument()).toBe(false);
  });

  it('survey keeps a document that already existed, and one that is speaking', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(), () => undefined);
    await engine.survey();
    expect(host.closes).toBe(0);
  });

  it('survey reports available:false when speechSynthesis is missing or the probe fails', async () => {
    expect(await new OffscreenSpeechEngine({ host: emptyHost(false) }).survey()).toEqual({
      available: false,
      voices: [],
    });
    const host = makeHost();
    host.ensureDocument = () => Promise.reject(new Error('no offscreen'));
    expect(await new OffscreenSpeechEngine({ host }).survey()).toEqual({
      available: false,
      voices: [],
    });
  });

  it('survey of an empty machine is a fresh probe each time (re-probe on GET_VOICES)', async () => {
    const host = emptyHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.survey();
    await engine.survey();
    expect(host.creates).toBe(2);
  });
});

describe('OffscreenSpeechEngine: races between stop, speak and survey', () => {
  it('a slow stop does not clobber a newer utterance (L1)', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(ID_A), () => undefined);

    let releaseExists: ((exists: boolean) => void) | undefined;
    host.hasDocument = () =>
      new Promise<boolean>((resolve) => {
        releaseExists = resolve;
      });
    const stopping = engine.stop();
    // A newer utterance starts while the stop is still checking for the document.
    const events: EngineEvent[] = [];
    host.hasDocument = () => Promise.resolve(true);
    await engine.speak(request(ID_B), (event) => events.push(event));
    releaseExists?.(true);
    await stopping;

    // The newer utterance is still the current one: its events arrive, and the page was told to
    // stop nothing after it started.
    engine.handlePageEvent({
      v: 1,
      type: 'SPEECH_OFFSCREEN_EVENT',
      requestId: ID_B,
      state: 'started',
    });
    expect(events).toEqual([{ state: 'started' }]);
    const sentTypes = host.sent.map((m) => m.type);
    expect(sentTypes.lastIndexOf('SPEECH_OFFSCREEN_STOP')).toBeLessThan(
      sentTypes.lastIndexOf('SPEECH_OFFSCREEN_SPEAK'),
    );
    expect(sentTypes.filter((t) => t === 'SPEECH_OFFSCREEN_STOP')).toHaveLength(0);
  });

  it('a stop that arrives while the document is starting means no audio is started', async () => {
    const host = makeHost();
    let releaseDocument: (() => void) | undefined;
    host.ensureDocument = () =>
      new Promise<void>((resolve) => {
        releaseDocument = resolve;
      });
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    const speaking = expect(engine.speak(request(ID_A), () => undefined)).rejects.toThrow(
      /Cancelled before it started/,
    );
    await engine.stop();
    releaseDocument?.();
    await speaking;
    expect(host.sent.map((m) => m.type)).not.toContain('SPEECH_OFFSCREEN_SPEAK');
  });

  it('a survey never closes the document under a speak that began meanwhile (L2)', async () => {
    const host = makeHost();
    let releaseVoices: (() => void) | undefined;
    const original = host.send as (message: unknown) => Promise<unknown>;
    host.send = vi.fn((message: unknown) => {
      if ((message as { type?: string }).type === 'SPEECH_OFFSCREEN_GET_VOICES') {
        return new Promise((resolve) => {
          releaseVoices = () => resolve(original(message));
        });
      }
      return original(message);
    });
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    const surveying = engine.survey();
    await vi.advanceTimersByTimeAsync(0);
    // A speak starts while the survey still waits for the page's voices.
    await engine.speak(request(ID_A), () => undefined);
    releaseVoices?.();
    await surveying;
    expect(host.closes).toBe(0);
    expect(await host.hasDocument()).toBe(true);
  });

  it('work started during a close waits for it, so it never lands on the closing document', async () => {
    const host = makeHost();
    const engine = new OffscreenSpeechEngine({ host, idleCloseMs: IDLE });
    await engine.speak(request(ID_A), () => undefined);
    let releaseClose: (() => void) | undefined;
    const close = host.closeDocument;
    host.closeDocument = () =>
      new Promise<void>((resolve) => {
        releaseClose = () => resolve(close());
      });
    const closing = engine.closeNow();
    let spoke = false;
    const speaking = engine.speak(request(ID_B), () => undefined).then(() => (spoke = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(spoke).toBe(false);
    releaseClose?.();
    await closing;
    await speaking;
    expect(await host.hasDocument()).toBe(true);
  });
});
