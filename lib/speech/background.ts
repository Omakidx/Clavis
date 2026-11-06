import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import {
  idSchema,
  parsePublicMessage,
  voiceNameSchema,
  type ErrorCode,
  type ErrorReason,
  type MessageIssue,
  type MessageReply,
  type Preferences,
  type PublicMessage,
  type SpeakResult,
  type StopResult,
  type TtsEventMessage,
  type VoiceInfo,
  type VoicesReport,
} from '../contracts';
import { t } from '../i18n';
import { failure as codedFailure } from '../router/replies';
import { logger } from '../security/logger';
import { ChromeTtsEngine } from './engines/chrome-tts';
import { SpeechService } from './service';
import {
  SpeechError,
  type SpeechMessageKey,
  type SpeechStateEvent,
  type SpeechVoice,
} from './types';
import { hasUsableVoice, resolveLanguage, toLanguageTag } from './voice-selection';

export type TtsSpeakReplyData = SpeakResult;
export type TtsStopReplyData = StopResult;

type Platform = VoicesReport['platform'];

/** Where to push state events for one request: the page/frame/document that asked. */
export interface PushTarget {
  tabId?: number | undefined;
  frameId?: number | undefined;
  documentId?: string | undefined;
}

export interface SpeechHandlerDeps {
  service: SpeechService;
  push(target: PushTarget, message: TtsEventMessage): Promise<unknown>;
  /** The speech preferences. A failing read behaves like "no preferences". */
  preferences(): Promise<Pick<Preferences, 'ttsLang' | 'ttsVoice'>>;
  /** `runtime.getPlatformInfo().os` mapped to the report's platform names. */
  platform(): Promise<Platform>;
}

/** Where a speech request came from. Supplied by the router from the classified sender. */
export interface SpeechSender {
  /** Absent for tab-less extension pages (the popup). */
  tabId?: number | undefined;
  frameId?: number | undefined;
  /** Chrome's id of the sender's document; preferred over `frameId` when pushing events. */
  documentId?: string | undefined;
}

type TtsSpeakMessage = Extract<PublicMessage, { type: 'TTS_SPEAK' }>;
type TtsStopMessage = Extract<PublicMessage, { type: 'TTS_STOP' }>;

/** Echo a correlation id only if it is a well-formed UUID; never any other caller-supplied value. */
function requestIdOf(raw: unknown): string | undefined {
  const id =
    typeof raw === 'object' && raw !== null
      ? (raw as { requestId?: unknown }).requestId
      : undefined;
  return typeof id === 'string' && idSchema.safeParse(id).success ? id : undefined;
}

function failure(
  code: ErrorCode,
  messageKey: SpeechMessageKey | undefined,
  fallback: string,
  requestId?: string,
): MessageReply<never> {
  let message = '';
  try {
    message = messageKey === undefined ? '' : t(messageKey);
  } catch {
    // A broken i18n lookup must not turn a clean error reply into a thrown exception.
  }
  message ||= fallback;
  return { ok: false, ...(requestId === undefined ? {} : { requestId }), error: { code, message } };
}

function invalidReply(raw: unknown, issues: MessageIssue[], reason: string): MessageReply<never> {
  const tooLong =
    reason === 'too_large' || issues.some((i) => i.path === 'text' && i.code === 'too_big');
  return tooLong
    ? failure('SELECTION_TOO_LONG', 'speechInvalidRequest', 'Text is too long.', requestIdOf(raw))
    : failure('INVALID_REQUEST', 'speechInvalidRequest', 'Invalid request.', requestIdOf(raw));
}

/**
 * Reply for a TTS_SPEAK that failed schema validation: SELECTION_TOO_LONG when the text
 * was the problem (the UI offers "Use the first 2,000 characters"), else INVALID_REQUEST.
 */
export function rejectedSpeakReply(raw: unknown): MessageReply<never> {
  const parsed = parsePublicMessage(raw);
  return parsed.ok
    ? failure('INVALID_REQUEST', 'speechInvalidRequest', 'Invalid request.', requestIdOf(raw))
    : invalidReply(raw, parsed.issues, parsed.reason);
}

/** Legacy reason accepted by the reply contract; Automatic can now use online voices. */
const ONLINE_ONLY_REASON: ErrorReason = 'online-only';

/** Largest voice lists the report carries (voicesReportSchema). */
const MAX_REPORTED_VOICES = 500;

/**
 * Voices as the Settings chooser may offer them: only voices TTS_SPEAK can address by name and
 * that could prove they started, one per name, at most `MAX_REPORTED_VOICES`.
 */
export function toVoiceInfos(voices: readonly SpeechVoice[]): VoiceInfo[] {
  const seen = new Set<string>();
  const out: VoiceInfo[] = [];
  for (const voice of voices) {
    if (out.length >= MAX_REPORTED_VOICES) break;
    if (!hasUsableVoice([voice]) || seen.has(voice.name)) continue;
    if (!voiceNameSchema.safeParse(voice.name).success) continue;
    seen.add(voice.name);
    const lang = toLanguageTag(voice.lang);
    out.push({
      name: voice.name,
      ...(lang === undefined ? {} : { lang }),
      engine: voice.engine,
      remote: voice.remote,
    });
  }
  return out;
}

/** Map `runtime.getPlatformInfo().os`. */
export function toPlatform(os: string | undefined): Platform {
  switch (os) {
    case 'linux':
    case 'mac':
    case 'win':
    case 'cros':
    case 'android':
      return os;
    default:
      return 'other';
  }
}

/**
 * Speech handlers for the message router. The router owns sender checks and schema validation;
 * these receive validated messages and the sender's location.
 *
 * Replies are always envelopes: `started` only once audio has actually started, and terminal
 * states (`ended`, `cancelled`, `error`) are pushed to exactly the document that asked.
 */
export function createSpeechHandlers(deps: SpeechHandlerDeps) {
  const { service } = deps;
  const targets = new Map<string, PushTarget>();
  /** Bumped by every speak(), so a request that was overtaken while reading preferences yields. */
  let latestSpeak = 0;
  /** Requests accepted but not yet handed to the service (reading preferences). */
  const preparing = new Set<string>();
  /** Preparing requests a Stop already cancelled; checked right before the service is called. */
  const stoppedEarly = new Set<string>();
  let platformCache: Promise<Platform> | undefined;

  const platform = (): Promise<Platform> => {
    platformCache ??= deps.platform().catch((): Platform => 'other');
    return platformCache;
  };

  async function readPreferences(): Promise<Pick<Preferences, 'ttsLang' | 'ttsVoice'>> {
    try {
      return await deps.preferences();
    } catch {
      return {};
    }
  }

  /** The machine-readable reason a NO_VOICE carries, so the UI can give the right advice. */
  async function reasonFor(error: SpeechError): Promise<ErrorReason | undefined> {
    if (error.code !== 'NO_VOICE') return undefined;
    switch (error.noVoice) {
      // No engine has any voice at all: on Linux that is the speech-dispatcher case.
      case 'no-voices':
        return (await platform()) === 'linux' ? 'no-voice-linux' : undefined;
      case 'no-language-match':
        return 'no-voice-language';
      case 'online-only':
        return ONLINE_ONLY_REASON;
      case 'start-failed':
        return 'start-failed';
      default:
        return undefined;
    }
  }

  // Push terminal states to whoever asked. `started` is the TTS_SPEAK reply itself.
  service.onState((event: SpeechStateEvent) => {
    if (event.state === 'started') return;
    const target = targets.get(event.requestId);
    targets.delete(event.requestId);
    if (target === undefined) return;
    deps
      .push(target, {
        v: MESSAGE_VERSION,
        type: 'TTS_EVENT',
        requestId: event.requestId,
        state: event.state,
      })
      .catch(() => {
        // The page is gone (navigated or closed); nothing is waiting for the event.
      });
  });

  async function failedSpeak(error: unknown, requestId: string): Promise<MessageReply<never>> {
    if (error instanceof SpeechError) {
      const reason = await reasonFor(error);
      if (reason !== undefined) return codedFailure(error.code, { requestId, reason });
      return failure(error.code, error.messageKey, error.message, requestId);
    }
    logger.error('speech_unexpected_failure', { requestId });
    return failure('NO_VOICE', 'speechStartFailed', 'Speech failed.', requestId);
  }

  return {
    async speak(
      message: TtsSpeakMessage,
      sender: SpeechSender,
    ): Promise<MessageReply<TtsSpeakReplyData>> {
      const { requestId, text, rate } = message;
      const turn = ++latestSpeak;
      targets.set(requestId, {
        tabId: sender.tabId,
        frameId: sender.frameId,
        documentId: sender.documentId,
      });
      preparing.add(requestId);
      try {
        const preferences = await readPreferences();
        const stopped = stoppedEarly.delete(requestId);
        preparing.delete(requestId);
        if (stopped) {
          // A Stop for this request arrived before the service knew about it: no audio.
          throw new SpeechError(
            'REQUEST_CANCELLED',
            'Stopped before it started.',
            'speechCancelled',
          );
        }
        if (turn !== latestSpeak) {
          // A newer request arrived while preferences were being read: it replaces this one.
          throw new SpeechError(
            'REQUEST_CANCELLED',
            'Superseded by a newer request.',
            'speechCancelled',
          );
        }
        const result = await service.speak({
          requestId,
          text,
          lang: resolveLanguage(message.lang, preferences.ttsLang),
          rate,
          voiceName: message.voiceName,
          preferredVoice: preferences.ttsVoice,
        });
        const lang = toLanguageTag(result.lang);
        const voiceName = voiceNameSchema.safeParse(result.voiceName).success
          ? result.voiceName
          : undefined;
        return {
          ok: true,
          requestId,
          data: {
            state: 'started',
            engine: result.engine,
            ...(voiceName === undefined ? {} : { voiceName }),
            ...(lang === undefined ? {} : { lang }),
            remote: result.remote,
          },
        };
      } catch (error) {
        preparing.delete(requestId);
        stoppedEarly.delete(requestId);
        targets.delete(requestId);
        return failedSpeak(error, requestId);
      }
    },

    /**
     * Stop speech. A tab (content script or reader) may only stop ITS OWN utterance, with or
     * without a requestId (Phase 2 review: an id-less stop from any tab used to stop all speech;
     * ownership is that of the utterance actually being spoken). Tab-less extension pages (the
     * popup) are global controls and stop anything. A request that is still being prepared (reading
     * preferences, looking up voices) is stoppable too, so a Stop never loses the race against its
     * audio. With nothing tracked at all (the worker restarted mid-utterance) a stop, with or
     * without an id, still reaches the engines, because chrome.tts keeps speaking untracked.
     */
    async stop(
      message: TtsStopMessage,
      sender: SpeechSender,
    ): Promise<MessageReply<TtsStopReplyData>> {
      const { requestId } = message;
      const reply = (stopped: boolean): MessageReply<TtsStopReplyData> => ({
        ok: true,
        ...(requestId === undefined ? {} : { requestId }),
        data: { stopped },
      });
      const owns = (target: PushTarget | undefined): boolean =>
        sender.tabId === undefined || target?.tabId === sender.tabId;

      // Requests the service has not been told about yet.
      let cancelledEarly = false;
      for (const id of preparing) {
        if ((requestId === undefined || requestId === id) && owns(targets.get(id))) {
          stoppedEarly.add(id);
          cancelledEarly = true;
        }
      }

      const tracked = service.trackedRequestId;
      if (tracked !== undefined) {
        if ((requestId === undefined || requestId === tracked) && owns(targets.get(tracked))) {
          return reply((await service.stop(requestId)) || cancelledEarly);
        }
        return reply(cancelledEarly);
      }
      // Nothing is tracked. Unless a request is being prepared, this is speech the restarted
      // worker lost track of: stop the engines.
      if (targets.size === 0 && preparing.size === 0) {
        await service.stop();
        return reply(false);
      }
      return reply(cancelledEarly);
    },

    /**
     * GET_VOICES (Settings voice chooser, FR-025): the voices of this device, freshly probed.
     * The contract still has an `offscreen` engine slot (D-07: the fallback was not adopted), so
     * it is reported as unavailable and empty.
     */
    async getVoices(): Promise<MessageReply<VoicesReport>> {
      const [os, voices] = await Promise.all([platform(), service.listVoices()]);
      const chromeVoices = toVoiceInfos(voices);
      return {
        ok: true,
        data: {
          platform: os,
          defaultEngine: chromeVoices.length > 0 ? 'chrome-tts' : 'none',
          engines: {
            chromeTts: { voices: chromeVoices },
            offscreen: { available: false, voices: [] },
          },
        },
      };
    },
  };
}

export type SpeechHandlers = ReturnType<typeof createSpeechHandlers>;

/** The browser's UI language, used only to prefer a matching voice when a request names no language. */
function uiLanguage(): string | undefined {
  try {
    return toLanguageTag(browser.i18n.getUILanguage());
  } catch {
    return undefined;
  }
}

export interface CreateSpeechDeps {
  /** Reads the saved preferences (`ttsLang`, `ttsVoice`). */
  preferences: SpeechHandlerDeps['preferences'];
}

/**
 * Build the speech stack for the service worker. Registers NO message listener: its messages
 * (TTS_SPEAK, TTS_STOP, GET_VOICES) are routes in the single message router
 * (lib/router), which checks senders and validates shapes.
 *
 * - The service lives in the worker's memory. If the worker is torn down mid utterance,
 *   chrome.tts keeps speaking but tracking is lost (an id-less TTS_STOP still stops it).
 * - State events are pushed with tabs.sendMessage, targeted at the asking DOCUMENT (falling back
 *   to its frame), or runtime.sendMessage for tab-less extension pages (popup). Never text.
 * - `tts.onVoicesChanged` forgets remembered "no voices" answers (speech-dispatcher installed).
 */
export function createSpeech(deps: CreateSpeechDeps): SpeechHandlers {
  const service = new SpeechService({
    engine: new ChromeTtsEngine(),
    defaultLanguage: uiLanguage(),
    watchVoiceChanges: (listener) => {
      // Chrome 124+. Boot must survive a missing or unimplemented event (older builds, test doubles).
      try {
        (
          browser.tts as { onVoicesChanged?: { addListener(callback: () => void): void } }
        ).onVoicesChanged?.addListener(listener);
      } catch {
        logger.warn('tts_voices_changed_unavailable');
      }
    },
  });

  return createSpeechHandlers({
    service,
    preferences: deps.preferences,
    platform: async () => toPlatform((await browser.runtime.getPlatformInfo()).os),
    push: (target, message) =>
      target.tabId === undefined
        ? (browser.runtime.sendMessage(message) as Promise<unknown>)
        : (browser.tabs.sendMessage(
            target.tabId,
            message,
            // A document id names exactly one document (it changes on navigation), so an event
            // never reaches a page that replaced the asker; the frame id is only the fallback.
            target.documentId !== undefined
              ? { documentId: target.documentId }
              : target.frameId === undefined
                ? {}
                : { frameId: target.frameId },
          ) as Promise<unknown>),
  });
}
