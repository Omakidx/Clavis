import { describe, expect, it } from 'vitest';
import {
  errorEnvelopeSchema,
  parsePrivilegedMessage,
  parsePublicMessage,
  preferencesPatchSchema,
  preferencesSchema,
  DEFAULT_PREFERENCES,
  speakResultSchema,
  stopResultSchema,
  ttsEventMessageSchema,
  voicesReportSchema,
} from '../../../lib/contracts';

const ID = '11111111-1111-4111-8111-111111111111';
const speak = { v: 1, type: 'TTS_SPEAK', requestId: ID, text: 'bank', rate: 1 };

describe('Phase 6 speech contracts', () => {
  it('TTS_SPEAK takes an optional bounded voiceName and nothing else new', () => {
    expect(parsePublicMessage(speak).ok).toBe(true);
    expect(parsePublicMessage({ ...speak, voiceName: 'Google US English' }).ok).toBe(true);
    expect(parsePublicMessage({ ...speak, voiceName: '' }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, voiceName: 'x'.repeat(129) }).ok).toBe(false);
    expect(parsePublicMessage({ ...speak, engine: 'chrome-tts' }).ok).toBe(false);
  });

  it('GET_VOICES is a privileged message only', () => {
    const message = { v: 1, type: 'GET_VOICES' };
    expect(parsePrivilegedMessage(message).ok).toBe(true);
    expect(parsePublicMessage(message).ok).toBe(false);
    expect(parsePrivilegedMessage({ ...message, extra: 1 }).ok).toBe(false);
  });

  it('TTS_EVENT carries only a terminal state, never text', () => {
    for (const state of ['ended', 'cancelled', 'error']) {
      expect(
        ttsEventMessageSchema.safeParse({ v: 1, type: 'TTS_EVENT', requestId: ID, state }).success,
      ).toBe(true);
    }
    for (const bad of [{ state: 'started' }, { state: 'ended', text: 'bank' }]) {
      expect(
        ttsEventMessageSchema.safeParse({ v: 1, type: 'TTS_EVENT', requestId: ID, ...bad }).success,
      ).toBe(false);
    }
  });

  it('reply data shapes are strict', () => {
    expect(
      speakResultSchema.safeParse({
        state: 'started',
        engine: 'chrome-tts',
        voiceName: 'v',
        lang: 'en-US',
        remote: false,
      }).success,
    ).toBe(true);
    expect(
      speakResultSchema.safeParse({ state: 'queued', engine: 'chrome-tts', remote: false }).success,
    ).toBe(false);
    expect(stopResultSchema.safeParse({ stopped: true }).success).toBe(true);
    expect(stopResultSchema.safeParse({ stopped: true, x: 1 }).success).toBe(false);
  });

  it('the voices report describes both engines, and `none` is a legal default', () => {
    const report = {
      platform: 'linux',
      defaultEngine: 'none',
      engines: { chromeTts: { voices: [] }, offscreen: { available: true, voices: [] } },
    };
    expect(voicesReportSchema.safeParse(report).success).toBe(true);
    expect(voicesReportSchema.safeParse({ ...report, platform: 'beos' }).success).toBe(false);
    expect(
      voicesReportSchema.safeParse({
        ...report,
        defaultEngine: 'offscreen-web-speech',
        engines: {
          ...report.engines,
          offscreen: {
            available: true,
            voices: [
              { name: 'Alex', lang: 'en-US', engine: 'offscreen-web-speech', remote: false },
            ],
          },
        },
      }).success,
    ).toBe(true);
  });

  it('the no-voice-linux reason travels in the error envelope', () => {
    expect(
      errorEnvelopeSchema.safeParse({ code: 'NO_VOICE', message: 'm', reason: 'no-voice-linux' })
        .success,
    ).toBe(true);
    expect(
      errorEnvelopeSchema.safeParse({ code: 'NO_VOICE', message: 'm', reason: 'other' }).success,
    ).toBe(false);
  });

  it('ttsVoice is an optional preference that a patch can set and clear', () => {
    expect(preferencesSchema.safeParse({ ...DEFAULT_PREFERENCES, ttsVoice: 'Alex' }).success).toBe(
      true,
    );
    expect(preferencesPatchSchema.safeParse({ ttsVoice: 'Alex' }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ ttsVoice: null }).success).toBe(true);
    expect(preferencesPatchSchema.safeParse({ ttsVoice: '' }).success).toBe(false);
  });
});
