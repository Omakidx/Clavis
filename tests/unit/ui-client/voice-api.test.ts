import { beforeEach, describe, expect, it } from 'vitest';
import { MESSAGE_VERSION } from '../../../lib/config/constants';
import { api } from '../../../lib/ui-client/api';
import { describeError } from '../../../lib/ui-client/errors';
import { request } from '../../../lib/ui-client/request';
import { speakResultSchema } from '../../../lib/contracts';
import { createFakeBackend, installBackend, installCatalog, NO_VOICES } from './support';

beforeEach(() => installCatalog());

describe('NO_VOICE errors (FR-023)', () => {
  it('uses the "no voice" text and an OS-specific hint', () => {
    const linux = describeError('NO_VOICE', undefined, 'no-voice-linux');
    expect(linux.message).toBe("Voice isn't available on this device.");
    expect(linux.hint).toBe(
      'Install speech-dispatcher and a voice such as espeak-ng, then restart Chrome.',
    );
    const other = describeError('NO_VOICE');
    expect(other.message).toBe(linux.message);
    expect(other.hint).toBe(
      'Install a text-to-speech voice in your system settings, then restart Chrome.',
    );
  });

  it('maps each NO_VOICE reason to its own message, hint and action', () => {
    const language = describeError('NO_VOICE', undefined, 'no-voice-language');
    expect(language.message).toMatch(/No voice on this device speaks this language/);
    expect(language.hint).toBeUndefined();
    const online = describeError('NO_VOICE', undefined, 'online-only');
    expect(online.message).toBe(
      'Only online voices are available for this language. To use one, choose it in Voice settings.',
    );
    expect(online.hint).toBeUndefined();
    const failed = describeError('NO_VOICE', undefined, 'start-failed');
    expect(failed.message).toMatch(/The voice didn't start/);
    expect(failed.hint).toBeUndefined();
    expect(failed.action).toBe('retry');
    expect(describeError('NO_VOICE', undefined, 'no-voice-linux').action).toBe('none');
  });

  it('gives no hint to other errors', () => {
    expect(describeError('NETWORK_ERROR').hint).toBeUndefined();
  });

  it('request() carries the reason of the error envelope, never its provider message', async () => {
    const result = await request(
      { type: 'TTS_SPEAK', requestId: 'r', text: 'hi', rate: 1 },
      speakResultSchema,
      {
        send: () =>
          Promise.resolve({
            ok: false,
            error: { code: 'NO_VOICE', message: 'secret detail', reason: 'no-voice-linux' },
          }),
      },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_VOICE' } });
    if (!result.ok) {
      expect(result.error.hint).toContain('speech-dispatcher');
      expect(JSON.stringify(result.error)).not.toContain('secret detail');
    }
  });
});

describe('voice api wrappers', () => {
  it('getVoices validates the report', async () => {
    installBackend(createFakeBackend());
    const result = await api.getVoices();
    expect(result).toEqual({ ok: true, data: NO_VOICES });
  });

  it('speak carries the voice name and is never retried when nobody answers', async () => {
    const backend = createFakeBackend({ silentReplies: 5 });
    installBackend(backend);
    const result = await api.speak({ requestId: 'r', text: 'hi', rate: 1, voiceName: 'Alex' });
    expect(result).toMatchObject({ ok: false, error: { code: 'NO_RESPONSE' } });
    // silentReplies swallow messages before they are recorded: exactly one attempt was made.
    expect(5 - backend.state.silent).toBe(1);
  });

  it('speak and stop send the wire messages the background expects', async () => {
    const backend = createFakeBackend();
    installBackend(backend);
    await api.speak({ requestId: 'r', text: 'hi', rate: 0.75, voiceName: 'Alex' });
    await api.stopSpeaking('r');
    expect(backend.calls[0]).toMatchObject({
      v: MESSAGE_VERSION,
      type: 'TTS_SPEAK',
      voiceName: 'Alex',
      rate: 0.75,
    });
    expect(backend.calls[1]).toMatchObject({ type: 'TTS_STOP', requestId: 'r' });
  });
});
