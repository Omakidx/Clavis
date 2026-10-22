import { logger } from '../../security/logger';
import { MESSAGE_VERSION } from '../../config/constants';
import { SPEECH_TIMING } from '../constants';
import {
  offscreenAckSchema,
  offscreenVoicesReplySchema,
  type OffscreenEventMessage,
} from '../messages';
import type { OffscreenHost } from '../offscreen-host';
import type { EngineEvent, EngineSpeakRequest, SpeechEngine, SpeechVoice } from '../types';

export interface OffscreenEngineOptions {
  host: OffscreenHost;
  idleCloseMs?: number;
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
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private current: { requestId: string; sink: (event: EngineEvent) => void } | undefined;

  constructor(options: OffscreenEngineOptions) {
    this.host = options.host;
    this.idleCloseMs = options.idleCloseMs ?? SPEECH_TIMING.offscreenIdleCloseMs;
  }

  async getVoices(): Promise<SpeechVoice[]> {
    this.cancelIdleClose();
    try {
      await this.host.ensureDocument();
      const reply = offscreenVoicesReplySchema.safeParse(
        await this.host.send({
          v: MESSAGE_VERSION,
          target: 'offscreen',
          type: 'SPEECH_OFFSCREEN_GET_VOICES',
        }),
      );
      if (!reply.success) throw new Error('Offscreen page returned an unexpected voice reply.');
      return reply.data.voices.map((voice) => ({ ...voice, engine: this.id }));
    } finally {
      // Probing alone must not keep the document alive.
      if (this.current === undefined) this.scheduleIdleClose();
    }
  }

  async speak(request: EngineSpeakRequest, sink: (event: EngineEvent) => void): Promise<void> {
    this.cancelIdleClose();
    this.current = { requestId: request.requestId, sink };
    try {
      await this.host.ensureDocument();
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
      this.current = undefined;
      this.scheduleIdleClose();
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Never create the document just to stop; if it is gone nothing can be speaking.
    if (!(await this.host.hasDocument())) {
      this.current = undefined;
      return;
    }
    try {
      await this.host.send({
        v: MESSAGE_VERSION,
        target: 'offscreen',
        type: 'SPEECH_OFFSCREEN_STOP',
      });
    } catch (error) {
      logger.warn('offscreen_stop_failed', {
        status: error instanceof Error ? error.message : 'unknown',
      });
    }
    this.current = undefined;
    this.scheduleIdleClose();
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
    if (this.current === undefined) void this.closeNow();
  }

  /** Close the document immediately (idle timer, shutdown, tests). */
  async closeNow(): Promise<void> {
    this.cancelIdleClose();
    this.current = undefined;
    try {
      await this.host.closeDocument();
    } catch (error) {
      logger.warn('offscreen_close_failed', {
        status: error instanceof Error ? error.message : 'unknown',
      });
    }
  }

  private scheduleIdleClose(): void {
    this.cancelIdleClose();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      if (this.current === undefined) void this.closeNow();
    }, this.idleCloseMs);
  }

  private cancelIdleClose(): void {
    clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }
}
