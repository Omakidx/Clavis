import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import {
  idSchema,
  parsePublicMessage,
  type ErrorCode,
  type MessageIssue,
  type MessageReply,
  type PublicMessage,
} from '../contracts';
import { t } from '../i18n';
import { logger } from '../security/logger';
import { ChromeTtsEngine } from './engines/chrome-tts';
import { OffscreenSpeechEngine } from './engines/offscreen';
import { type OffscreenEventMessage, type TtsEventMessage } from './messages';
import { createOffscreenHost } from './offscreen-host';
import { SpeechService } from './service';
import {
  SpeechError,
  type SpeakResult,
  type SpeechCapability,
  type SpeechMessageKey,
  type SpeechStateEvent,
} from './types';

/** `data` of a successful TTS_SPEAK reply: audio has started (never "queued"). */
export interface TtsSpeakReplyData extends Omit<SpeakResult, 'requestId'> {
  state: 'started';
}
export interface TtsStopReplyData {
  /** Whether a tracked utterance was actually cancelled. */
  stopped: boolean;
}
/** Spike-only diagnostics for the voice matrix (extension pages only). */
export interface SpeechDiagnoseReplyData {
  capability: SpeechCapability;
  offscreenApi: { getContexts: boolean; hasDocument: boolean; matchClients: boolean };
  userAgent: string;
}

/** Where to push state events for one request: the page/frame that asked to speak. */
interface PushTarget {
  tabId?: number | undefined;
  frameId?: number | undefined;
}

export interface SpeechHandlerDeps {
  service: SpeechService;
  offscreenEngine: Pick<OffscreenSpeechEngine, 'handlePageEvent' | 'handlePageIdle'>;
  push(target: PushTarget, message: TtsEventMessage): Promise<unknown>;
  offscreenApi?: SpeechDiagnoseReplyData['offscreenApi'];
  userAgent?: string;
}

/** Where a speech request came from. Supplied by the router from the classified sender. */
export interface SpeechSender {
  /** Absent for tab-less extension pages (the popup). */
  tabId?: number | undefined;
  frameId?: number | undefined;
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

/**
 * Speech handlers for the message router (Phase 3). The router owns sender checks and
 * schema validation; these receive validated messages and the sender's tab.
 *
 * Replies are always envelopes: `started` only once audio has actually started.
 */
export function createSpeechHandlers(deps: SpeechHandlerDeps) {
  const { service } = deps;
  const targets = new Map<string, PushTarget>();

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

  return {
    async speak(
      message: TtsSpeakMessage,
      sender: SpeechSender,
    ): Promise<MessageReply<TtsSpeakReplyData>> {
      const { requestId, text, lang, rate } = message;
      targets.set(requestId, { tabId: sender.tabId, frameId: sender.frameId });
      try {
        const result = await service.speak({ requestId, text, lang, rate });
        const { requestId: _omit, ...rest } = result;
        return { ok: true, requestId, data: { ...rest, state: 'started' } };
      } catch (error) {
        targets.delete(requestId);
        if (error instanceof SpeechError) {
          return failure(error.code, error.messageKey, error.message, requestId);
        }
        logger.error('speech_unexpected_failure', { requestId });
        return failure('NO_VOICE', 'speechStartFailed', 'Speech failed.', requestId);
      }
    },

    /**
     * Stop speech. A tab (content script or reader) may only stop ITS OWN utterance, with or
     * without a requestId (Phase 2 review: an id-less stop from any tab used to stop all
     * speech). Tab-less extension pages (the popup) are global controls and stop anything.
     * With nothing tracked at all (the worker restarted mid-utterance) an id-less stop still
     * reaches the engines, because chrome.tts keeps speaking untracked.
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
      if (sender.tabId !== undefined) {
        const owns = (target: PushTarget | undefined): boolean => target?.tabId === sender.tabId;
        if (requestId !== undefined) {
          if (!owns(targets.get(requestId))) return reply(false);
        } else if (targets.size > 0 && ![...targets.values()].some(owns)) {
          return reply(false);
        }
      }
      return reply(await service.stop(requestId));
    },

    async diagnose(): Promise<MessageReply<SpeechDiagnoseReplyData>> {
      return {
        ok: true,
        data: {
          capability: await service.getCapability({ probeAll: true }),
          offscreenApi: deps.offscreenApi ?? {
            getContexts: false,
            hasDocument: false,
            matchClients: false,
          },
          userAgent: deps.userAgent ?? '',
        },
      };
    },

    offscreenEvent(event: OffscreenEventMessage): void {
      deps.offscreenEngine.handlePageEvent(event);
    },

    offscreenIdle(): void {
      deps.offscreenEngine.handlePageIdle();
    },
  };
}

export type SpeechHandlers = ReturnType<typeof createSpeechHandlers>;

/**
 * Build the speech stack for the service worker. Registers NO listener: its messages
 * (TTS_SPEAK, TTS_STOP, SPEECH_DIAGNOSE, the offscreen events) are routes in the single
 * message router (lib/router), which checks senders and validates shapes.
 *
 * Phase 6 design notes (Spike D):
 * - The service lives in the worker's memory. If the worker is torn down mid
 *   utterance, chrome.tts keeps speaking but tracking is lost.
 * - State events are pushed with tabs.sendMessage (frame-targeted) to the tab
 *   that asked, or runtime.sendMessage for tab-less extension pages (popup).
 */
export function createSpeech(): SpeechHandlers {
  const offscreenEngine = new OffscreenSpeechEngine({ host: createOffscreenHost() });
  const service = new SpeechService({ engines: [new ChromeTtsEngine(), offscreenEngine] });

  return createSpeechHandlers({
    service,
    offscreenEngine,
    offscreenApi: {
      getContexts: typeof browser.runtime.getContexts === 'function',
      hasDocument: typeof browser.offscreen?.hasDocument === 'function',
      matchClients: typeof (globalThis as { clients?: unknown }).clients === 'object',
    },
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    push: (target, message) =>
      target.tabId === undefined
        ? (browser.runtime.sendMessage(message) as Promise<unknown>)
        : (browser.tabs.sendMessage(
            target.tabId,
            message,
            target.frameId === undefined ? {} : { frameId: target.frameId },
          ) as Promise<unknown>),
  });
}
