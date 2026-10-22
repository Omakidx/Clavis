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
