import { browser } from 'wxt/browser';
import { MESSAGE_VERSION, TTS_RATES } from '../config/constants';
import type { MessageKey } from '../i18n';
import type { ListenReport, RunContext, ToolbarActions } from './ui-api';

/**
 * Listen (FR-020..FR-024): the content-side half of TTS_SPEAK / TTS_STOP / TTS_EVENT.
 *
 * Shared by the content script and the practice page, so both behave the same. Plain objects and
 * no zod on purpose: this ships inside the observer (budget 18 KB gzip, D-20).
 *
 * Truthfulness rules:
 * - Only the selected text is sent (`snapshot.text`), never the context (FR-024).
 * - "Playing" is reported only after the background replied `started` (it replies once audio
 *   really started); until then the toolbar shows a spinner, with a backstop timeout.
 * - Stop, a newer Listen, a new selection and dismissal all abort the run's signal, which sends
 *   TTS_STOP; the background's TTS_EVENT (ended / cancelled / error) returns the button to idle.
 */

/**
 * Backstop for audio that never starts. The background gives up after ~5 s overall and answers;
 * this is above that, so it only fires when no answer comes at all (worker gone).
 */
export const LISTEN_START_TIMEOUT_MS = 7000;

export interface ListenDeps {
  send(message: unknown): Promise<unknown>;
  newId(): string;
  startTimeoutMs: number;
  /** Mirror of every report, for a host that shows the state elsewhere too (the practice page). */
  onReport?(report: ListenReport, context: RunContext): void;
}

export interface ListenController {
  /** `ToolbarActions.listen`. */
  listen: NonNullable<ToolbarActions['listen']>;
  /** `ToolbarActions.openVoiceSettings`. */
  openVoiceSettings(): void;
  /** Feed every runtime message here; true when it was a TTS_EVENT for one of our runs. */
  handleEvent(message: unknown): boolean;
}

const defaultDeps: ListenDeps = {
  send: (message) => browser.runtime.sendMessage(message),
  newId: () => crypto.randomUUID(),
  startTimeoutMs: LISTEN_START_TIMEOUT_MS,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

type TerminalEvent = 'ended' | 'cancelled' | 'error';

/**
 * Speed for one playback. With no choice the preference is used as it is; the toolbar's Slow
 * toggle picks Slow (0.75) or Normal (the preference when it is not slow, else 1.0).
 */
export function listenRate(choice: boolean | undefined, preferred: number): number {
  if (choice === undefined) return preferred;
  if (choice) return TTS_RATES.slow;
  return preferred < TTS_RATES.normal ? TTS_RATES.normal : preferred;
}

/** What a failed TTS_SPEAK reply means, as toolbar report. */
function failureReport(reply: unknown): ListenReport {
  if (reply === undefined || reply === null) {
    return { status: 'failed', message: 'errNoResponse' };
  }
  const error = isRecord(reply) && reply['ok'] === false ? reply['error'] : undefined;
  if (!isRecord(error) || typeof error['code'] !== 'string') {
    return { status: 'failed', message: 'errInvalidResponse' };
  }
  const code = error['code'];
  if (code === 'NO_VOICE') {
    // Exactly what the reason says; an unknown reason gets the generic copy.
    const reason = error['reason'];
    // A voice exists but did not start: nothing to install, and trying again may work.
    if (reason === 'start-failed') return { status: 'failed', message: 'speechStartFailed' };
    // Voices exist, none for this language: no install hint, Settings may offer another voice.
    if (reason === 'no-voice-language') {
      return { status: 'unavailable', message: 'speechNoVoiceForLanguage' };
    }
    // Only online voices exist for this language: never used unless chosen in Settings (D-22).
    if (reason === 'online-only') return { status: 'unavailable', message: 'speechOnlineOnly' };
    const hint: MessageKey =
      reason === 'no-voice-linux' ? 'speechNoVoiceLinuxHint' : 'speechNoVoiceHint';
    return { status: 'unavailable', message: 'speechNoVoice', hint };
  }
  // Replaced by a newer request elsewhere before anything played: nothing to replay.
  if (code === 'REQUEST_CANCELLED') return { status: 'idle' };
  if (code === 'INVALID_REQUEST' || code === 'SELECTION_TOO_LONG') {
    return { status: 'failed', message: 'speechInvalidRequest' };
  }
  if (code === 'TIMEOUT') return { status: 'failed', message: 'speechTimedOut' };
  return { status: 'failed', message: 'toolbarActionFailed' };
}

export function createListenController(overrides: Partial<ListenDeps> = {}): ListenController {
  const deps: ListenDeps = { ...defaultDeps, ...overrides };
  /** Runs that were sent and have not ended: requestId -> its terminal-event handler. */
  const runs = new Map<string, (event: TerminalEvent) => void>();

  const call = async (message: Record<string, unknown>): Promise<unknown> => {
    try {
      return await deps.send({ v: MESSAGE_VERSION, ...message });
    } catch {
      return undefined;
    }
  };

  /** Preferences Listen needs. Defaults apply when the background does not answer. */
  async function preferences(): Promise<{ rate: number; lang?: string }> {
    const reply = await call({ type: 'GET_PUBLIC_SETTINGS' });
    const data = isRecord(reply) && isRecord(reply['data']) ? reply['data'] : {};
    const rate = data['ttsRate'];
    const lang = data['ttsLang'];
    return {
      rate:
        typeof rate === 'number' && rate >= TTS_RATES.min && rate <= TTS_RATES.max
          ? rate
          : TTS_RATES.normal,
      ...(typeof lang === 'string' && lang !== '' ? { lang } : {}),
    };
  }

  return {
    listen(context) {
      const surface = context.listen;
      if (surface === undefined) return;
      const { snapshot, signal } = context;
      const requestId = deps.newId();
      /** starting: waiting for `started`. playing: audio runs. done: nothing more will be reported. */
      let phase = 'starting' as 'starting' | 'playing' | 'done';
      let sent = false;
      const now = (): typeof phase => phase;
      let early: TerminalEvent | null = null;
      let slow = false;

      const report = (value: ListenReport): void => {
        deps.onReport?.(value, context);
        if (!signal.aborted) surface.report(value);
      };
      // Backstop: audio that never starts must not leave a spinner (FR-023).
      const timer = setTimeout(() => {
        if (phase !== 'starting') return;
        finish();
        stopSpeaking();
        report({ status: 'failed', message: 'speechTimedOut' });
      }, deps.startTimeoutMs);
      const finish = (): void => {
        phase = 'done';
        clearTimeout(timer);
        runs.delete(requestId);
      };
      const stopSpeaking = (): void => {
        if (sent) void call({ type: 'TTS_STOP', requestId });
      };
      const terminal = (event: TerminalEvent): void => {
        if (phase === 'done') return;
        if (phase === 'starting') {
          // The end can overtake the reply of a very short utterance: settle when it arrives.
          early = event;
          return;
        }
        finish();
        report(
          event === 'error'
            ? { status: 'ended', message: 'speechPlaybackError' }
            : { status: 'ended' },
        );
      };

      signal.addEventListener(
        'abort',
        () => {
          if (phase === 'done') return;
          finish();
          stopSpeaking();
          deps.onReport?.({ status: 'idle' }, context);
        },
        { once: true },
      );
      if (signal.aborted) {
        finish();
        return;
      }

      report({ status: 'starting' });

      void (async () => {
        const prefs = await preferences();
        if (now() === 'done') return;
        const rate = listenRate(surface.slow, prefs.rate);
        slow = rate < TTS_RATES.normal;
        const lang = surface.lang ?? prefs.lang ?? snapshot.languageHint;
        runs.set(requestId, terminal);
        sent = true;
        const reply = await call({
          type: 'TTS_SPEAK',
          requestId,
          // Only what the user selected; never the surrounding context (FR-024).
          text: snapshot.text,
          rate,
          ...(lang === undefined ? {} : { lang }),
        });
        if (now() !== 'starting') {
          // Timed out or aborted while waiting: a late `started` must not leave audio running.
          if (now() === 'done' && isRecord(reply) && reply['ok'] === true) stopSpeaking();
          return;
        }
        const data = isRecord(reply) && reply['ok'] === true ? reply['data'] : undefined;
        if (!isRecord(data) || data['state'] !== 'started') {
          finish();
          report(failureReport(reply));
          return;
        }
        phase = 'playing';
        clearTimeout(timer);
        if (early !== null) {
          terminal(early);
          return;
        }
        report({ status: 'playing', slow, remote: data['remote'] === true });
      })();
    },

    openVoiceSettings() {
      void call({ type: 'OPEN_SETTINGS', section: 'voice' });
    },

    handleEvent(message) {
      if (
        !isRecord(message) ||
        message['type'] !== 'TTS_EVENT' ||
        message['v'] !== MESSAGE_VERSION ||
        typeof message['requestId'] !== 'string'
      ) {
        return false;
      }
      const state = message['state'];
      const handler = runs.get(message['requestId']);
      if (handler === undefined) return false;
      if (state === 'ended' || state === 'cancelled' || state === 'error') handler(state);
      return true;
    },
  };
}
