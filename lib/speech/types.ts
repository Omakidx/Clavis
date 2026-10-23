import type { ErrorCode, SpeechEngine as SpeechEngineName } from '../contracts';

/** Concrete engines that can produce audio (the contract's engine names). */
export type SpeechEngineId = SpeechEngineName;

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

/** What one engine reported when surveyed for the Settings voice report (GET_VOICES). */
export interface EngineSurvey {
  engine: SpeechEngineId;
  /** False when the engine could not run at all (no `speechSynthesis`, offscreen document failed). */
  available: boolean;
  voices: SpeechVoice[];
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
  /** Language of the text, already resolved by the caller (message, else preference). */
  lang?: string | undefined;
  rate: number;
  /**
   * Exact voice the caller asked for (Settings "Test voice"). Authoritative: if no engine has a
   * voice of this name the request fails with NO_VOICE; no other voice stands in.
   */
  voiceName?: string | undefined;
  /**
   * The saved voice preference. Used only if the voice still exists on this device and speaks
   * `lang`; otherwise the best match for `lang` is used.
   */
  preferredVoice?: string | undefined;
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

export interface EngineSpeakRequest {
  requestId: string;
  text: string;
  /** The chosen voice's own language when a voice was chosen, else the requested language. */
  lang?: string | undefined;
  rate: number;
  /** Voice picked by the service; undefined means "engine default". */
  voice?: SpeechVoice | undefined;
}

/** Engine-agnostic contract implemented by chrome.tts and the offscreen Web Speech engine. */
export interface SpeechEngine {
  readonly id: SpeechEngineId;
  /**
   * May reject; the service treats a rejection as "engine unavailable". May wait (bounded) for a
   * voice list that loads late. An empty answer is remembered until `invalidate()` or
   * `refresh: true`, so a machine without voices is not made to wait on every request.
   */
  getVoices(options?: { refresh?: boolean }): Promise<SpeechVoice[]>;
  /** Voices known right now, never waiting and never creating resources. Optional. */
  peekVoices?(): Promise<SpeechVoice[]>;
  /** Forget remembered "no voices" answers (the platform's voice list changed). Optional. */
  invalidate?(): void;
  /**
   * Fresh voices plus whether the engine can run at all, for the Settings report. Releases any
   * resource it had to create (the offscreen document). Optional: without it `getVoices`
   * with `refresh` is used.
   */
  survey?(): Promise<{ available: boolean; voices: SpeechVoice[] }>;
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
 * Why a NO_VOICE happened, for the caller to turn into advice:
 * - `no-voices`: no engine has any usable voice (on Linux: speech-dispatcher is missing).
 * - `no-language-match`: voices exist, none for this language (never substituted, FR-024).
 * - `online-only`: the only voices for this language are network voices, which Listen does not
 *   use unless the user chose one (D-22, the text would leave the device).
 * - `start-failed`: a voice was found but never started speaking.
 * - `voice-missing`: the explicitly requested voice is not installed.
 */
export type NoVoiceReason =
  'no-voices' | 'no-language-match' | 'online-only' | 'start-failed' | 'voice-missing';

/**
 * Failure of `SpeechService.speak`. `code` is a stable contract error code;
 * `messageKey` selects the localized user text; `message` is English diagnostics.
 */
export class SpeechError extends Error {
  readonly code: ErrorCode;
  readonly messageKey: SpeechMessageKey | undefined;
  readonly noVoice: NoVoiceReason | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    messageKey?: SpeechMessageKey,
    noVoice?: NoVoiceReason,
  ) {
    super(message);
    this.name = 'SpeechError';
    this.code = code;
    this.messageKey = messageKey;
    this.noVoice = noVoice;
  }
}
