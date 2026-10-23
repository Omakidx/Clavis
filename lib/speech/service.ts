import { LIMITS, TTS_RATES } from '../config/constants';
import { logger } from '../security/logger';
import { SPEECH_TIMING } from './constants';
import {
  SpeechError,
  type EngineEvent,
  type SpeakInput,
  type SpeakResult,
  type SpeechEngine,
  type SpeechStateEvent,
  type SpeechVoice,
} from './types';
import { findNamedVoice, hasUsableVoice, sameLanguage, selectVoice } from './voice-selection';

/** Voices tried per request: the saved/explicit one, then one best match. */
const MAX_ATTEMPTS = 2;

/** Resolves `undefined` instead of `promise`'s value when `ms` pass first. */
function orDeadline<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  if (ms <= 0) return Promise.resolve(undefined);
  return new Promise<T | undefined>((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve(undefined);
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

export interface SpeechServiceOptions {
  /** The speech engine (D-07: chrome.tts; the offscreen Web Speech fallback was not adopted). */
  engine: SpeechEngine;
  /** Longest an engine may take to report `start` for ONE attempt (also capped by the deadline). */
  startTimeoutMs?: number;
  /** Overall budget of one `speak()`: lookup and all attempts together. */
  speakDeadlineMs?: number;
  /**
   * Language of the system/UI. Only used when a request names no language, to prefer an
   * on-device voice that matches it.
   */
  defaultLanguage?: string | undefined;
  /**
   * Subscribe to "the platform's voice list changed" (`chrome.tts.onVoicesChanged`). Each change
   * forgets remembered "no voices" answers, so installing speech-dispatcher is picked up.
   */
  watchVoiceChanges?: (listener: () => void) => void;
}

type StateListener = (event: SpeechStateEvent) => void;

/** One in-flight utterance. Exactly one exists at a time. */
interface Utterance {
  requestId: string;
  engine: SpeechEngine;
  started: boolean;
  /** Reached ended / cancelled / error, or failed before start. Later events are ignored. */
  settled: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** Rejects the pending `speak()` while the utterance has not started yet. */
  failBeforeStart: (error: SpeechError) => void;
  resolveStart: () => void;
}

/** Clamp a finite rate into the supported range; reject anything else. */
export function normalizeRate(rate: number): number {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) {
    throw new SpeechError(
      'INVALID_REQUEST',
      'Speech rate must be a finite number.',
      'speechInvalidRequest',
    );
  }
  return Math.min(TTS_RATES.max, Math.max(TTS_RATES.min, rate));
}

function validate(input: SpeakInput): SpeakInput {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') {
    throw new SpeechError('INVALID_REQUEST', 'Nothing to speak.', 'speechInvalidRequest');
  }
  if (text.length > LIMITS.maxSelectionChars) {
    throw new SpeechError(
      'SELECTION_TOO_LONG',
      `Text exceeds ${LIMITS.maxSelectionChars} characters.`,
      'speechInvalidRequest',
    );
  }
  return { ...input, text, rate: normalizeRate(input.rate) };
}

/**
 * Speech facade (architecture §7). Owns voice choice, the one-utterance-at-a-time rule, state
 * events and the start deadline; the engine only knows how to talk to chrome.tts.
 *
 * Honesty rule (FR-023): `speak()` resolves only after the engine reported `start`. A voice that
 * never starts, errors early or ends silently is a failure, and when nothing can speak the result
 * is NO_VOICE, never a fake success.
 */
export class SpeechService {
  private readonly engine: SpeechEngine;
  private readonly startTimeoutMs: number;
  private readonly speakDeadlineMs: number;
  private readonly defaultLanguage: string | undefined;
  private readonly listeners = new Set<StateListener>();
  private active: Utterance | undefined;
  /** The `speak()` that has not started audio yet (looking up voices, between attempts). */
  private pending: { requestId: string; generation: number } | undefined;
  /** Bumped by every speak()/stop() so a stale speak() can detect it was superseded. */
  private generation = 0;

  constructor(options: SpeechServiceOptions) {
    this.engine = options.engine;
    this.startTimeoutMs = options.startTimeoutMs ?? SPEECH_TIMING.startTimeoutMs;
    this.speakDeadlineMs = options.speakDeadlineMs ?? SPEECH_TIMING.speakDeadlineMs;
    this.defaultLanguage = options.defaultLanguage;
    options.watchVoiceChanges?.(() => {
      this.invalidateVoices();
    });
  }

  /** Subscribe to state events. Returns an unsubscribe function. */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Forget a remembered "no voices" answer; the next request looks again. */
  invalidateVoices(): void {
    this.engine.invalidate?.();
  }

  /**
   * The voices of this device, freshly probed (Settings voice report, FR-025). Never rejects: an
   * engine that cannot answer has no voices.
   */
  async listVoices(): Promise<SpeechVoice[]> {
    try {
      return await this.engine.getVoices({ refresh: true });
    } catch (error) {
      logger.warn('speech_engine_unavailable', {
        mode: this.engine.id,
        status: describeError(error),
      });
      return [];
    }
  }

  /**
   * Speak, replacing whatever is playing. Resolves once audio has STARTED.
   * Rejects with SpeechError: NO_VOICE, REQUEST_CANCELLED (superseded or stopped before audio
   * started, including while voices were still being looked up), SELECTION_TOO_LONG or a
   * validation error.
   *
   * Time bound: the whole call (lookup plus every start attempt) shares `speakDeadlineMs`.
   *
   * Voice choice (never a voice for another language, FR-024; on-device only unless the user chose
   * a network voice, D-22):
   * 1. `voiceName`: exactly that voice. Missing: NO_VOICE.
   * 2. `preferredVoice`: that voice if it still exists and speaks `lang` (or no `lang` is known,
   *    or the voice reports no language); otherwise fall through, so a removed or mismatched saved
   *    voice never blocks Listen.
   * 3. Best ON-DEVICE voice for `lang` (exact tag, then same language), skipping a voice that
   *    already failed. Without `lang`, an on-device voice of the system language, else the first
   *    on-device voice. Network voices are never used here.
   */
  async speak(input: SpeakInput): Promise<SpeakResult> {
    const request = validate(input);
    const generation = ++this.generation;
    this.pending = { requestId: request.requestId, generation };
    this.cancelActive();
    try {
      return await this.run(request, generation);
    } finally {
      if (this.pending?.generation === generation) this.pending = undefined;
    }
  }

  private async run(request: SpeakInput, generation: number): Promise<SpeakResult> {
    const deadlineAt = Date.now() + this.speakDeadlineMs;
    const remaining = (): number => deadlineAt - Date.now();

    let voices: SpeechVoice[] | undefined;
    try {
      voices = await orDeadline(this.engine.getVoices(), remaining());
    } catch (error) {
      logger.warn('speech_engine_unavailable', {
        mode: this.engine.id,
        status: describeError(error),
      });
    }
    this.assertCurrent(generation);
    const all = voices ?? [];

    /** Voices that already failed to start in this call. */
    const failed = new Set<string>();
    let attempts = 0;
    const attempt = async (voice: SpeechVoice): Promise<SpeakResult | undefined> => {
      const budget = Math.min(this.startTimeoutMs, remaining());
      if (budget <= 0 || attempts >= MAX_ATTEMPTS) return undefined;
      attempts++;
      try {
        return await this.startOn(voice, request, budget);
      } catch (error) {
        if (error instanceof SpeechError && error.code === 'REQUEST_CANCELLED') throw error;
        logger.warn('speech_engine_failed', { mode: this.engine.id, requestId: request.requestId });
        this.assertCurrent(generation);
        failed.add(voice.name);
        return undefined;
      }
    };

    const named = request.voiceName ?? request.preferredVoice;
    if (named !== undefined) {
      const explicit = request.voiceName !== undefined;
      const voice = findNamedVoice(all, named);
      // A saved voice for another language than the text must not read it aloud. A voice that
      // reports no language was chosen by the user all the same, so it is accepted.
      const fits =
        voice !== undefined &&
        (explicit ||
          request.lang === undefined ||
          voice.lang === '' ||
          sameLanguage(voice.lang, request.lang));
      if (voice !== undefined && fits) {
        const result = await attempt(voice);
        if (result !== undefined) return result;
        // An explicit voice that does not start is an error; a saved one falls back to a match.
        if (explicit) {
          throw new SpeechError(
            'NO_VOICE',
            'The chosen voice never started speaking.',
            'speechStartFailed',
            'start-failed',
          );
        }
      } else if (voice === undefined && explicit) {
        throw all.length > 0
          ? new SpeechError(
              'NO_VOICE',
              'The chosen voice is not installed.',
              'speechNoVoiceForLanguage',
              'voice-missing',
            )
          : new SpeechError(
              'NO_VOICE',
              'No text-to-speech voice is available.',
              'speechNoVoice',
              'no-voices',
            );
      }
    }

    for (;;) {
      const open = all.filter((voice) => !failed.has(voice.name));
      const voice = this.bestLocalVoice(
        open.filter((candidate) => !candidate.remote),
        request.lang,
      );
      if (voice === undefined) break;
      const result = await attempt(voice);
      if (result !== undefined) return result;
      if (attempts >= MAX_ATTEMPTS || remaining() <= 0) break;
    }

    if (failed.size > 0 || attempts > 0) {
      throw new SpeechError(
        'NO_VOICE',
        'A voice was found but it never started speaking.',
        'speechStartFailed',
        'start-failed',
      );
    }
    // Network voices exist for this language, but Listen does not send text off the device.
    const online = this.bestLocalVoice(
      all.filter((voice) => voice.remote),
      request.lang,
    );
    if (online !== undefined) {
      throw new SpeechError(
        'NO_VOICE',
        'Only online voices exist for this language.',
        'speechNoVoiceForLanguage',
        'online-only',
      );
    }
    if (all.length > 0 && request.lang !== undefined) {
      throw new SpeechError(
        'NO_VOICE',
        `No installed voice matches language ${request.lang}.`,
        'speechNoVoiceForLanguage',
        'no-language-match',
      );
    }
    throw new SpeechError(
      'NO_VOICE',
      'No text-to-speech voice is available.',
      'speechNoVoice',
      'no-voices',
    );
  }

  /** Best voice of `voices` (all on-device) for `lang`; without `lang` the system-language voice, else the first. */
  private bestLocalVoice(
    voices: readonly SpeechVoice[],
    lang: string | undefined,
  ): SpeechVoice | undefined {
    if (lang !== undefined) {
      const selection = selectVoice(voices, lang);
      return selection.ok ? selection.voice : undefined;
    }
    const usable = voices.filter((voice) => hasUsableVoice([voice]));
    if (this.defaultLanguage !== undefined) {
      const system = selectVoice(usable, this.defaultLanguage);
      if (system.ok && system.voice !== undefined) return system.voice;
    }
    return usable[0];
  }

  /**
   * Stop speaking. With a `requestId`, only that utterance is stopped (a stale
   * Stop must not cut off a newer one); a request that is still looking up voices or between
   * start attempts counts as that request, so a Stop never loses a race against its audio.
   * Without one, everything is stopped, including speech this worker no longer tracks after a
   * restart. Returns whether a tracked request was cancelled.
   */
  async stop(requestId?: string): Promise<boolean> {
    const pendingMatch = requestId !== undefined && this.pending?.requestId === requestId;
    if (requestId !== undefined && !pendingMatch && this.active?.requestId !== requestId) {
      return false;
    }
    this.generation++;
    const hadPending = this.pending !== undefined && (requestId === undefined || pendingMatch);
    const cancelled = this.cancelActive();
    await this.stopEngine();
    return cancelled || hadPending;
  }

  /** Requests whose state events are still expected. */
  get activeRequestId(): string | undefined {
    return this.active?.requestId;
  }

  /** The request being spoken or still starting (looking up voices, trying a voice). */
  get trackedRequestId(): string | undefined {
    return this.active?.requestId ?? this.pending?.requestId;
  }

  // ---------------------------------------------------------------------------

  private assertCurrent(generation: number): void {
    if (generation !== this.generation) {
      throw new SpeechError(
        'REQUEST_CANCELLED',
        'Superseded by a newer request.',
        'speechCancelled',
      );
    }
  }

  /** One start attempt; fails (NO_VOICE) if audio has not started after `timeoutMs`. */
  private startOn(
    voice: SpeechVoice,
    request: SpeakInput,
    timeoutMs: number,
  ): Promise<SpeakResult> {
    const engine = this.engine;
    return new Promise<SpeakResult>((resolve, reject) => {
      const utterance: Utterance = {
        requestId: request.requestId,
        engine,
        started: false,
        settled: false,
        timer: undefined,
        failBeforeStart: (error) => {
          this.settle(utterance);
          reject(error);
        },
        resolveStart: () => {
          resolve({
            requestId: request.requestId,
            engine: engine.id,
            voiceName: voice.name || undefined,
            lang: voice.lang || request.lang,
            remote: voice.remote,
          });
        },
      };
      this.active = utterance;

      utterance.timer = setTimeout(() => {
        if (utterance.started || utterance.settled) return;
        // Reported support but no audio: stop the engine and fail honestly.
        this.stopQuietly();
        utterance.failBeforeStart(
          new SpeechError('NO_VOICE', 'The voice did not start in time.', 'speechStartFailed'),
        );
      }, timeoutMs);

      const sink = (event: EngineEvent): void => {
        this.handleEngineEvent(utterance, event);
      };
      const spoken = {
        requestId: request.requestId,
        text: request.text,
        // A chosen voice speaks its own language tag: engines reject or ignore a mismatching one.
        lang: voice.lang ? voice.lang : request.lang,
        rate: request.rate,
        voice,
      };
      engine.speak(spoken, sink).catch((error: unknown) => {
        if (utterance.settled) return;
        utterance.failBeforeStart(
          new SpeechError('NO_VOICE', describeError(error), 'speechStartFailed'),
        );
      });
    });
  }

  private handleEngineEvent(utterance: Utterance, event: EngineEvent): void {
    if (utterance.settled || this.active !== utterance) return;

    if (!utterance.started) {
      if (event.state === 'started') {
        utterance.started = true;
        clearTimeout(utterance.timer);
        this.emit(utterance, 'started');
        utterance.resolveStart();
        return;
      }
      // cancelled/error/ended before any `start`: no audio was proven. Fail so the next engine can try.
      this.stopQuietly();
      utterance.failBeforeStart(
        new SpeechError(
          'NO_VOICE',
          event.detail ?? `Engine reported "${event.state}" before starting.`,
          'speechStartFailed',
        ),
      );
      return;
    }

    if (event.state === 'started') return;
    this.settle(utterance);
    this.emit(utterance, event.state, event.detail);
  }

  /** Cancel the tracked utterance. Returns whether there was one. */
  private cancelActive(): boolean {
    const utterance = this.active;
    if (utterance === undefined || utterance.settled) return false;
    if (utterance.started) {
      this.settle(utterance);
      this.emit(utterance, 'cancelled');
    } else {
      utterance.failBeforeStart(
        new SpeechError('REQUEST_CANCELLED', 'Superseded by a newer request.', 'speechCancelled'),
      );
    }
    this.stopQuietly();
    return true;
  }

  private settle(utterance: Utterance): void {
    utterance.settled = true;
    clearTimeout(utterance.timer);
    if (this.active === utterance) this.active = undefined;
  }

  private stopQuietly(): void {
    void this.stopEngine();
  }

  /** Never rejects or throws, whatever the engine does. */
  private async stopEngine(): Promise<void> {
    try {
      await this.engine.stop();
    } catch (error) {
      logger.warn('speech_stop_failed', { mode: this.engine.id, status: describeError(error) });
    }
  }

  private emit(utterance: Utterance, state: SpeechStateEvent['state'], detail?: string): void {
    const event: SpeechStateEvent = {
      requestId: utterance.requestId,
      state,
      engine: utterance.engine.id,
      ...(detail === undefined ? {} : { detail }),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.error('speech_listener_failed', { status: describeError(error) });
      }
    }
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200);
}
