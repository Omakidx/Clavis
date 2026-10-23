import { logger } from '../../security/logger';
import { MESSAGE_VERSION } from '../../config/constants';
import { SPEECH_TIMING } from '../constants';
import {
  offscreenAckSchema,
  offscreenVoicesReplySchema,
  type OffscreenEventMessage,
} from '../messages';
import type { OffscreenHost } from '../offscreen-host';
import { withTimeout } from '../timeout';
import type { EngineEvent, EngineSpeakRequest, SpeechEngine, SpeechVoice } from '../types';

export interface OffscreenEngineOptions {
  host: OffscreenHost;
  idleCloseMs?: number;
  /** Bound for a voice query, document creation included. */
  probeTimeoutMs?: number;
}

/**
 * Web Speech (`speechSynthesis`) running in an offscreen document (D-07).
 * Owns the document lifecycle: created on first use, reused, and closed after
 * an idle period once nothing is speaking.
 */
export class OffscreenSpeechEngine implements SpeechEngine {
  readonly id = 'offscreen-web-speech' as const;

  private readonly host: OffscreenHost;
  private readonly idleCloseMs: number;
  private readonly probeTimeoutMs: number;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private current: { requestId: string; sink: (event: EngineEvent) => void } | undefined;
  /**
   * A complete probe found no voice (or no `speechSynthesis`). Remembered for the worker's
   * lifetime so a machine without voices does not create the document and wait on every request;
   * cleared by `invalidate()` (voices changed, or Settings asked for a fresh report).
   */
  private knownEmpty = false;
  /** Probes and speaks in flight: the document must not be closed under any of them. */
  private operations = 0;
  /** A close that is running; new work waits for it so it never lands on a fresh document. */
  private closing: Promise<void> | undefined;

  constructor(options: OffscreenEngineOptions) {
    this.host = options.host;
    this.idleCloseMs = options.idleCloseMs ?? SPEECH_TIMING.offscreenIdleCloseMs;
    this.probeTimeoutMs = options.probeTimeoutMs ?? SPEECH_TIMING.offscreenProbeTimeoutMs;
  }

  invalidate(): void {
    this.knownEmpty = false;
  }

  async getVoices(options: { refresh?: boolean } = {}): Promise<SpeechVoice[]> {
    if (options.refresh === true) this.invalidate();
    if (this.knownEmpty) return [];
    return (await this.probe()).voices;
  }

  /**
   * Fresh voices for the Settings report, plus whether the page could run at all. Creates the
   * document only if it is missing and closes it again unless speech is playing.
   */
  async survey(): Promise<{ available: boolean; voices: SpeechVoice[] }> {
    this.invalidate();
    const existed = await this.host.hasDocument().catch(() => false);
    try {
      const { supported, voices } = await this.probe();
      return { available: supported, voices };
    } catch (error) {
      logger.warn('offscreen_probe_failed', { status: describe(error) });
      return { available: false, voices: [] };
    } finally {
      // Only a document this survey created, and only if nothing is speaking or starting on it.
      if (!existed) await this.closeIfIdle();
    }
  }

  private async probe(): Promise<{ supported: boolean; voices: SpeechVoice[] }> {
    this.cancelIdleClose();
    await this.begin();
    try {
      const reply = await withTimeout(
        this.query(),
        this.probeTimeoutMs,
        'The offscreen document did not answer in time.',
      );
      if (reply.voices.length === 0) this.knownEmpty = true;
      return {
        supported: reply.supported,
        voices: reply.voices.map((voice) => ({ ...voice, engine: this.id })),
      };
    } finally {
      this.operations--;
      // Probing alone must not keep the document alive; one that found nothing to speak with has
      // no further use at all (the empty answer is remembered), so it is closed at once.
      if (this.current === undefined) {
        if (this.knownEmpty) await this.closeIfIdle();
        else this.scheduleIdleClose();
      }
    }
  }

  private async query() {
    await this.host.ensureDocument();
    const reply = offscreenVoicesReplySchema.safeParse(
      await this.host.send({
        v: MESSAGE_VERSION,
        target: 'offscreen',
        type: 'SPEECH_OFFSCREEN_GET_VOICES',
      }),
    );
    if (!reply.success) throw new Error('Offscreen page returned an unexpected voice reply.');
    return reply.data;
  }

  async speak(request: EngineSpeakRequest, sink: (event: EngineEvent) => void): Promise<void> {
    this.cancelIdleClose();
    const mine = { requestId: request.requestId, sink };
    this.current = mine;
    await this.begin();
    try {
      await this.host.ensureDocument();
      // A stop or a newer request arrived while the document was starting: do not start audio
      // nobody is tracking any more.
      if (this.current !== mine) throw new Error('Cancelled before it started.');
      const ack = offscreenAckSchema.safeParse(
        await this.host.send({
          v: MESSAGE_VERSION,
          target: 'offscreen',
          type: 'SPEECH_OFFSCREEN_SPEAK',
          requestId: request.requestId,
          text: request.text,
          ...(request.lang === undefined ? {} : { lang: request.lang }),
          ...(request.voice?.name ? { voiceName: request.voice.name } : {}),
          rate: request.rate,
        }),
      );
      if (!ack.success || !ack.data.ok) {
        throw new Error(
          ack.success ? (ack.data.detail ?? 'Offscreen page refused to speak.') : 'Bad ack.',
        );
      }
    } catch (error) {
      if (this.current === mine) {
        this.current = undefined;
        this.scheduleIdleClose();
      }
      throw error;
    } finally {
      this.operations--;
    }
  }

  async stop(): Promise<void> {
    // What was current when the stop was asked for; a newer utterance must not be clobbered by
    // this (slower) stop, neither its state nor, below, the command itself.
    const was = this.current;
    // Never create the document just to stop; if it is gone nothing can be speaking.
    if (!(await this.host.hasDocument())) {
      if (this.current === was) this.current = undefined;
      return;
    }
    if (this.current !== was) return;
    try {
      await this.host.send({
        v: MESSAGE_VERSION,
        target: 'offscreen',
        type: 'SPEECH_OFFSCREEN_STOP',
      });
    } catch (error) {
      logger.warn('offscreen_stop_failed', { status: describe(error) });
    }
    if (this.current === was) {
      this.current = undefined;
      this.scheduleIdleClose();
    }
  }

  /** Route an event relayed by the offscreen page (background wires this up). */
  handlePageEvent(event: OffscreenEventMessage): void {
    const current = this.current;
    if (current === undefined || current.requestId !== event.requestId) return;
    if (event.state !== 'started') {
      this.current = undefined;
      this.scheduleIdleClose();
    }
    current.sink({
      state: event.state,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
    });
  }

  /** The offscreen page's own idle notice (worker-restart safety net). */
  handlePageIdle(): void {
    void this.closeIfIdle();
  }

  /** Close the document immediately, whatever is going on (shutdown, tests). */
  async closeNow(): Promise<void> {
    this.cancelIdleClose();
    this.current = undefined;
    const closing = (async () => {
      try {
        await this.host.closeDocument();
      } catch (error) {
        logger.warn('offscreen_close_failed', { status: describe(error) });
      }
    })();
    this.closing = closing;
    try {
      await closing;
    } finally {
      if (this.closing === closing) this.closing = undefined;
    }
  }

  /** Close only when nothing is speaking, starting to speak or being probed. */
  private async closeIfIdle(): Promise<void> {
    if (this.current === undefined && this.operations === 0) await this.closeNow();
  }

  /** Register a speak or probe, after any close that is running has finished. */
  private async begin(): Promise<void> {
    this.operations++;
    await this.closing;
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      void this.closeIfIdle();
    }, this.idleCloseMs);
  }

  private cancelIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 200) : 'unknown';
}
