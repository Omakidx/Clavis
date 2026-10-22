import type { ErrorCode } from '../contracts';

/** Concrete engines that can produce audio. */
export type SpeechEngineId = 'chrome-tts' | 'offscreen-web-speech';

/** The engine routing would use right now, or `none` when no engine has a voice. */
export type SpeechCapabilityEngine = SpeechEngineId | 'none';

export interface SpeechVoice {
  name: string;
  /** BCP-47-ish tag as reported by the engine; empty string when the engine gave none. */
  lang: string;
  /** Network voice: higher latency, and the text leaves the device (requirements §4.3 disclosure). */
  remote: boolean;
  engine: SpeechEngineId;
  /** chrome.tts only: event types the voice promises to send. Absent means unknown. */
  eventTypes?: readonly string[] | undefined;
}

/** What an engine reported when probed. `error` is set when probing itself failed. */
export interface EngineProbe {
  engine: SpeechEngineId;
  voiceCount: number;
  error?: string | undefined;
}

export interface SpeechCapability {
  engine: SpeechCapabilityEngine;
  /** Voices of `engine` (empty when `none`). */
  voices: SpeechVoice[];
  /** Every engine that was probed, in routing order. */
  probes: EngineProbe[];
}

/** User-visible lifecycle of one utterance. `speak()` resolving means `started`. */
export type SpeechState = 'started' | 'ended' | 'cancelled' | 'error';

export interface SpeechStateEvent {
  requestId: string;
  state: SpeechState;
  engine: SpeechEngineId;
  /** Developer-facing detail for `error`. Never user text, never the spoken text. */
  detail?: string | undefined;
}

export interface SpeakInput {
  requestId: string;
  text: string;
  lang?: string | undefined;
  rate: number;
}

export interface SpeakResult {
  requestId: string;
  engine: SpeechEngineId;
  voiceName?: string | undefined;
  lang?: string | undefined;
  /** Whether the chosen voice is a network voice. */
  remote: boolean;
}

/** What an engine reports about one utterance. */
export interface EngineEvent {
  state: SpeechState;
  detail?: string | undefined;
}

export interface EngineSpeakRequest extends SpeakInput {
  /** Voice picked by the service for `lang`; undefined means "engine default". */
  voice?: SpeechVoice | undefined;
}

/** Engine-agnostic contract implemented by chrome.tts and the offscreen Web Speech engine. */
export interface SpeechEngine {
  readonly id: SpeechEngineId;
  /** May reject; the service treats a rejection as "engine unavailable". */
  getVoices(): Promise<SpeechVoice[]>;
  /** Resolves when the utterance was dispatched (NOT when audio started). Events go to `sink`. */
  speak(request: EngineSpeakRequest, sink: (event: EngineEvent) => void): Promise<void>;
  /** Stops current speech. Must not create resources (e.g. an offscreen document). */
  stop(): Promise<void>;
}

/** Message keys (public/_locales/en/messages.json) the background maps to user-facing text. */
export type SpeechMessageKey =
  | 'speechNoVoice'
  | 'speechNoVoiceForLanguage'
  | 'speechStartFailed'
  | 'speechInvalidRequest'
  | 'speechCancelled';

/**
 * Failure of `SpeechService.speak`. `code` is a stable contract error code;
 * `messageKey` selects the localized user text; `message` is English diagnostics.
 */
export class SpeechError extends Error {
  readonly code: ErrorCode;
  readonly messageKey: SpeechMessageKey | undefined;

  constructor(code: ErrorCode, message: string, messageKey?: SpeechMessageKey) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    this.messageKey = messageKey;
  }
}
