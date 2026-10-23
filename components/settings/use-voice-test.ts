import { useCallback, useEffect, useRef, useState } from 'react';
import { browser } from 'wxt/browser';
import { ttsEventMessageSchema } from '../../lib/contracts/speech';
import { t } from '../../lib/i18n';
import { api } from '../../lib/ui-client/api';
import type { ClientError } from '../../lib/ui-client/errors';

export type VoiceTestState =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'playing'; remote: boolean }
  | { kind: 'done' }
  | { kind: 'error'; error: ClientError };

export interface VoiceTest {
  state: VoiceTestState;
  /** Status text for the live region. */
  live: string | null;
  /** Speak the sample, or stop it while it plays. */
  toggle(input: {
    voiceName?: string | undefined;
    lang?: string | undefined;
    rate: number;
    /** What to read (in the voice's language where known). */
    text: string;
  }): void;
}

/**
 * "Test voice": TTS_SPEAK from the options page with an exact voice, driven by what the background
 * reports. It is "playing" only after the `started` reply and ends on the TTS_EVENT the background
 * sends back, so the button never shows a fake state (FR-023).
 */
export function useVoiceTest(): VoiceTest {
  const [state, setState] = useState<VoiceTestState>({ kind: 'idle' });
  const active = useRef<string | null>(null);

  const stop = useCallback(() => {
    const id = active.current;
    active.current = null;
    if (id !== null) void api.stopSpeaking(id);
  }, []);

  useEffect(() => {
    const onMessage = (message: unknown) => {
      const event = ttsEventMessageSchema.safeParse(message);
      if (!event.success || event.data.requestId !== active.current) return undefined;
      active.current = null;
      setState(
        event.data.state === 'error'
          ? {
              kind: 'error',
              error: { code: 'INTERNAL_ERROR', message: t('speechPlaybackError'), action: 'none' },
            }
          : { kind: 'done' },
      );
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => {
      browser.runtime.onMessage.removeListener(onMessage);
      stop();
    };
  }, [stop]);

  const toggle: VoiceTest['toggle'] = useCallback(
    ({ voiceName, lang, rate, text }) => {
      if (active.current !== null) {
        stop();
        setState({ kind: 'idle' });
        return;
      }
      const requestId = crypto.randomUUID();
      active.current = requestId;
      setState({ kind: 'starting' });
      void api
        .speak({
          requestId,
          text,
          rate,
          ...(voiceName === undefined ? {} : { voiceName }),
          ...(lang === undefined ? {} : { lang }),
        })
        .then((result) => {
          // Stopped, left or replaced while waiting: ignore the late answer, but if it says audio
          // started, stop that audio (it would otherwise play with no way to stop it).
          if (active.current !== requestId) {
            if (result.ok) void api.stopSpeaking(requestId);
            return;
          }
          if (result.ok) {
            setState({ kind: 'playing', remote: result.data.remote });
          } else {
            active.current = null;
            setState({ kind: 'error', error: result.error });
          }
        });
    },
    [stop],
  );

  const live =
    state.kind === 'starting'
      ? t('voiceTestStarting')
      : state.kind === 'playing'
        ? t('voiceTestPlaying')
        : state.kind === 'done'
          ? t('voiceTestDone')
          : null;

  return { state, live, toggle };
}
