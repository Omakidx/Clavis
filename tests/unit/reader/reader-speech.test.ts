import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { parseReaderSpeechEvent, readerSpeech } from '../../../lib/pdf/reader-speech';

const ID = '11111111-1111-4111-8111-111111111111';
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const SPEAK = { requestId: ID, text: 'first second', rate: 1, trackWords: true as const };
const STARTED = { state: 'started', engine: 'chrome-tts', remote: false };

beforeEach(() => {
  vi.spyOn(fakeBrowser.i18n, 'getMessage').mockImplementation((key) => `msg:${key}`);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('readerSpeech', () => {
  it('reads only the speech preferences from the public settings reply', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: true,
      data: { ttsRate: 1.25, ttsLang: 'en-US', hasKey: false, model: 'ignored' },
    } as never);
    expect(await readerSpeech.getPublicSettings()).toEqual({
      ok: true,
      data: { ttsRate: 1.25, ttsLang: 'en-US' },
    });
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'GET_PUBLIC_SETTINGS' });
  });

  it('rejects invalid public speech preferences', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage');
    for (const data of [
      { ttsRate: Number.NaN },
      { ttsRate: 3 },
      { ttsRate: 1, ttsLang: 'bad tag' },
    ]) {
      send.mockResolvedValueOnce({ ok: true, data } as never);
      const result = await readerSpeech.getPublicSettings();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('BAD_REPLY');
    }
  });

  it('sends one opted-in request and validates the started reply and correlation id', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockResolvedValue({
      ok: true,
      requestId: ID,
      data: STARTED,
    } as never);
    expect(await readerSpeech.speak(SPEAK)).toEqual({ ok: true, data: STARTED });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'TTS_SPEAK', ...SPEAK });
    send.mockResolvedValueOnce({ ok: true, requestId: OTHER_ID, data: STARTED } as never);
    const wrong = await readerSpeech.speak(SPEAK);
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.error.code).toBe('BAD_REPLY');
  });

  it('rejects malformed and forged replies without displaying the wire message', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage');
    for (const reply of [
      { ok: true, requestId: ID, data: { ...STARTED, voiceName: 'x'.repeat(129) } },
      { ok: true, requestId: ID, data: { ...STARTED, remote: 'yes' } },
      { ok: true, requestId: ID, data: { ...STARTED, text: 'secret' } },
      { ok: false, requestId: ID, error: { code: 'MADE_UP', message: 'provider text' } },
      {
        ok: false,
        requestId: ID,
        error: { code: 'NO_VOICE', message: 'provider text', extra: 'secret' },
      },
      { ok: true, data: STARTED },
    ]) {
      send.mockResolvedValueOnce(reply as never);
      const result = await readerSpeech.speak(SPEAK);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('BAD_REPLY');
        expect(result.error.message).not.toContain('provider text');
      }
    }
    send.mockResolvedValueOnce({
      ok: false,
      requestId: ID,
      error: { code: 'NO_VOICE', message: 'provider text', reason: 'start-failed' },
    } as never);
    const result = await readerSpeech.speak(SPEAK);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('NO_VOICE');
      expect(result.error.message).not.toContain('provider text');
    }
  });

  it('times out a silent speech reply without retrying', async () => {
    vi.useFakeTimers();
    const send = vi
      .spyOn(browser.runtime, 'sendMessage')
      .mockImplementation(() => new Promise(() => undefined));
    const pending = readerSpeech.speak(SPEAK);
    await vi.advanceTimersByTimeAsync(7_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('NO_RESPONSE');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('stops best effort and never throws on a missing worker', async () => {
    const send = vi.spyOn(browser.runtime, 'sendMessage').mockRejectedValue(new Error('gone'));
    await expect(readerSpeech.stopSpeaking(ID)).resolves.toBeUndefined();
    expect(send).toHaveBeenCalledWith({ v: 1, type: 'TTS_STOP', requestId: ID });
  });
});

describe('parseReaderSpeechEvent', () => {
  it('accepts real boundary and terminal shapes, including an early boundary for the caller to hold', () => {
    expect(
      parseReaderSpeechEvent({ v: 1, type: 'TTS_BOUNDARY', requestId: ID, charIndex: 6 }),
    ).toEqual({
      type: 'TTS_BOUNDARY',
      requestId: ID,
      charIndex: 6,
    });
    expect(
      parseReaderSpeechEvent({
        v: 1,
        type: 'TTS_BOUNDARY',
        requestId: ID,
        charIndex: 0,
        length: 5,
      }),
    ).toEqual({
      type: 'TTS_BOUNDARY',
      requestId: ID,
      charIndex: 0,
      length: 5,
    });
    expect(
      parseReaderSpeechEvent({ v: 1, type: 'TTS_EVENT', requestId: ID, state: 'ended' }),
    ).toEqual({
      type: 'TTS_EVENT',
      requestId: ID,
      state: 'ended',
    });
  });

  it('rejects malformed, out-of-range, and text-bearing pushes', () => {
    const boundary = { v: 1, type: 'TTS_BOUNDARY', requestId: ID, charIndex: 2 };
    for (const message of [
      { ...boundary, v: 2 },
      { ...boundary, requestId: 'forged' },
      { ...boundary, charIndex: -1 },
      { ...boundary, charIndex: 2001 },
      { ...boundary, charIndex: 1.5 },
      { ...boundary, length: Number.NaN },
      { ...boundary, text: 'secret' },
      { v: 1, type: 'TTS_EVENT', requestId: ID, state: 'started' },
      { v: 1, type: 'TTS_EVENT', requestId: ID, state: 'error', detail: 'secret' },
    ])
      expect(parseReaderSpeechEvent(message)).toBeNull();
  });
});
