import { LIMITS, TTS_RATES } from '../config/constants';
import { logger } from '../security/logger';
import { SPEECH_TIMING } from './constants';
import {
  SpeechError,
  type EngineEvent,
  type EngineProbe,
  type SpeakInput,
  type SpeakResult,
  type SpeechCapability,
  type SpeechEngine,
  type SpeechStateEvent,
  type SpeechVoice,
} from './types';
import { selectVoice } from './voice-selection';

export interface SpeechServiceOptions {
  /** Routing order: the first engine with a suitable voice wins (D-07: chrome.tts, then offscreen). */
  engines: readonly SpeechEngine[];
  startTimeoutMs?: number;
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
      'INVALID_RESPONSE',
      'Speech rate must be a finite number.',
      'speechInvalidRequest',
    );
  }
  return Math.min(TTS_RATES.max, Math.max(TTS_RATES.min, rate));
}

function validate(input: SpeakInput): SpeakInput {
  const text = typeof input.text === 'string' ? input.text.trim() : '';
  if (text === '') {
    throw new SpeechError('INVALID_RESPONSE', 'Nothing to speak.', 'speechInvalidRequest');
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
 * Engine-agnostic speech facade (architecture §7). Owns routing, the
 * one-utterance-at-a-time rule, state events and the start timeout; engines
 * only know how to talk to chrome.tts or the offscreen document.
 *
 * Honesty rule (FR-023): `speak()` resolves only after an engine reported
 * `start`. Engines that never start, error early or end silently are failures,
 * and when no engine can speak the result is NO_VOICE, never a fake success.
 */
export class SpeechService {
  private readonly engines: readonly SpeechEngine[];
  private readonly startTimeoutMs: number;
  private readonly listeners = new Set<StateListener>();
  private active: Utterance | undefined;
  /** Bumped by every speak()/stop() so a stale speak() can detect it was superseded. */
  private generation = 0;

  constructor(options: SpeechServiceOptions) {
    this.engines = options.engines;
    this.startTimeoutMs = options.startTimeoutMs ?? SPEECH_TIMING.startTimeoutMs;
  }

  /** Subscribe to state events. Returns an unsubscribe function. */
  onState(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Which engine would speak now, and its voices. Probing stops at the first
   * engine that has voices unless `probeAll` is set (diagnostics), so the
   * offscreen document is not created when chrome.tts already works.
   */
  async getCapability(options: { probeAll?: boolean } = {}): Promise<SpeechCapability> {
    const probes: EngineProbe[] = [];
    let chosen: { engine: SpeechEngine; voices: SpeechVoice[] } | undefined;
    for (const engine of this.engines) {
      if (chosen !== undefined && options.probeAll !== true) break;
      try {
        const voices = await engine.getVoices();
        probes.push({ engine: engine.id, voiceCount: voices.length });
        if (chosen === undefined && voices.length > 0) chosen = { engine, voices };
      } catch (error) {
        probes.push({ engine: engine.id, voiceCount: 0, error: describeError(error) });
      }
    }
    return chosen === undefined
      ? { engine: 'none', voices: [], probes }
      : { engine: chosen.engine.id, voices: chosen.voices, probes };
  }

  /** Voices of the engine routing would use. */
  async getVoices(): Promise<SpeechVoice[]> {
    return (await this.getCapability()).voices;
  }

  /**
   * Speak, replacing whatever is playing. Resolves once audio has STARTED.
   * Rejects with SpeechError: NO_VOICE, REQUEST_CANCELLED (superseded or
   * stopped while starting), SELECTION_TOO_LONG or a validation error.
   */
  async speak(input: SpeakInput): Promise<SpeakResult> {
    const request = validate(input);
    const generation = ++this.generation;
    this.cancelActive();

    let sawVoices = false;
    let sawLanguageMatch = false;
    for (const engine of this.engines) {
      let voices: SpeechVoice[];
      try {
        voices = await engine.getVoices();
      } catch (error) {
        logger.warn('speech_engine_unavailable', { mode: engine.id, status: describeError(error) });
        continue;
      }
      this.assertCurrent(generation);
      if (voices.length > 0) sawVoices = true;

      const selection = selectVoice(voices, request.lang);
      if (!selection.ok) continue;
      sawLanguageMatch = true;

      try {
        return await this.startOn(engine, selection.voice, request);
      } catch (error) {
        if (error instanceof SpeechError && error.code === 'REQUEST_CANCELLED') throw error;
        logger.warn('speech_engine_failed', { mode: engine.id, requestId: request.requestId });
        this.assertCurrent(generation);
      }
    }

    if (sawLanguageMatch) {
      throw new SpeechError(
        'NO_VOICE',
        'A voice was found but it never started speaking.',
        'speechStartFailed',
      );
    }
    if (sawVoices && request.lang !== undefined) {
      throw new SpeechError(
        'NO_VOICE',
        `No installed voice matches language ${request.lang}.`,
        'speechNoVoiceForLanguage',
      );
    }
    throw new SpeechError('NO_VOICE', 'No text-to-speech voice is available.', 'speechNoVoice');
  }

  /**
   * Stop speaking. With a `requestId`, only that utterance is stopped (a stale
   * Stop must not cut off a newer one). Without one, everything is stopped,
   * including speech this worker no longer tracks after a restart. Returns
   * whether a tracked utterance was cancelled.
   */
  async stop(requestId?: string): Promise<boolean> {
    if (requestId !== undefined && this.active?.requestId !== requestId) return false;
    this.generation++;
    const cancelled = this.cancelActive();
    await Promise.all(this.engines.map((engine) => this.stopEngine(engine)));
    return cancelled;
  }

  /** Requests whose state events are still expected. */
  get activeRequestId(): string | undefined {
    return this.active?.requestId;
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

  private startOn(
    engine: SpeechEngine,
    voice: SpeechVoice | undefined,
    request: SpeakInput,
  ): Promise<SpeakResult> {
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
            voiceName: voice?.name,
            lang: voice?.lang ?? request.lang,
            remote: voice?.remote ?? false,
          });
        },
      };
      this.active = utterance;

      utterance.timer = setTimeout(() => {
        if (utterance.started || utterance.settled) return;
        // Reported support but no audio: stop the engine and fail honestly.
        this.stopQuietly(engine);
        utterance.failBeforeStart(
          new SpeechError('NO_VOICE', 'The voice did not start in time.', 'speechStartFailed'),
        );
      }, this.startTimeoutMs);

      const sink = (event: EngineEvent): void => {
        this.handleEngineEvent(utterance, event);
      };
      engine.speak({ ...request, voice }, sink).catch((error: unknown) => {
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
      this.stopQuietly(utterance.engine);
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
    this.stopQuietly(utterance.engine);
    return true;
  }

  private settle(utterance: Utterance): void {
    utterance.settled = true;
    clearTimeout(utterance.timer);
    if (this.active === utterance) this.active = undefined;
  }

  private stopQuietly(engine: SpeechEngine): void {
    void this.stopEngine(engine);
  }

  /** Never rejects or throws, whatever the engine does. */
  private async stopEngine(engine: SpeechEngine): Promise<void> {
    try {
      await engine.stop();
    } catch (error) {
      logger.warn('speech_stop_failed', { mode: engine.id, status: describeError(error) });
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
