import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../config/constants';
import {
  parsePublicMessage,
  type ErrorCode,
  type MessageIssue,
  type MessageReply,
} from '../contracts';
import { t } from '../i18n';
import { logger } from '../security/logger';
import { OFFSCREEN_PAGE_PATH } from './constants';
import { ChromeTtsEngine } from './engines/chrome-tts';
import { OffscreenSpeechEngine } from './engines/offscreen';
import {
  offscreenEventSchema,
  offscreenIdleSchema,
  speechDiagnoseSchema,
  type TtsEventMessage,
} from './messages';
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

export interface SpeechRouterDeps {
  service: SpeechService;
  offscreenEngine: Pick<OffscreenSpeechEngine, 'handlePageEvent' | 'handlePageIdle'>;
  runtimeId: string;
  /** `chrome-extension://<id>/` */
  extensionUrlPrefix: string;
  /** Absolute URL of the offscreen page, to authenticate relayed events. */
  offscreenPageUrl: string;
  push(target: PushTarget, message: TtsEventMessage): Promise<unknown>;
  offscreenApi?: SpeechDiagnoseReplyData['offscreenApi'];
  userAgent?: string;
}

type SenderLike = {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { id?: number | undefined } | undefined;
  frameId?: number | undefined;
};

const IGNORED = undefined;

// There is no INVALID_REQUEST code in lib/contracts/errors.ts yet (proposed in
// the Spike D report). Until then validation failures use INVALID_RESPONSE.
const INVALID_REQUEST_CODE: ErrorCode = 'INVALID_RESPONSE';

function messageType(raw: unknown): unknown {
  return typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
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

function requestIdOf(raw: unknown): string | undefined {
  const id =
    typeof raw === 'object' && raw !== null
      ? (raw as { requestId?: unknown }).requestId
      : undefined;
  return typeof id === 'string' && id.length <= 64 ? id : undefined;
}

function invalidReply(raw: unknown, issues: MessageIssue[], reason: string): MessageReply<never> {
  const tooLong =
    reason === 'too_large' || issues.some((i) => i.path === 'text' && i.code === 'too_big');
  return tooLong
    ? failure('SELECTION_TOO_LONG', 'speechInvalidRequest', 'Text is too long.', requestIdOf(raw))
    : failure(INVALID_REQUEST_CODE, 'speechInvalidRequest', 'Invalid request.', requestIdOf(raw));
}

/**
 * Message router for the speech module. Returns a pending reply for the speech
 * messages it owns and `undefined` for everything else, so other modules'
 * `runtime.onMessage` listeners keep working (only the first listener that
 * replies wins, so this must never claim a message that is not its own).
 */
export function createSpeechRouter(deps: SpeechRouterDeps) {
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

  const fromThisExtension = (sender: SenderLike): boolean => sender.id === deps.runtimeId;
  const fromExtensionPage = (sender: SenderLike): boolean =>
    fromThisExtension(sender) && sender.url?.startsWith(deps.extensionUrlPrefix) === true;
  const fromOffscreenPage = (sender: SenderLike): boolean =>
    fromThisExtension(sender) && sender.url?.startsWith(deps.offscreenPageUrl) === true;

  async function speak(raw: unknown, sender: SenderLike): Promise<MessageReply<TtsSpeakReplyData>> {
    if (!fromThisExtension(sender)) {
      return failure('PERMISSION_DENIED', undefined, 'Not allowed.', requestIdOf(raw));
    }
    const parsed = parsePublicMessage(raw);
    if (!parsed.ok) return invalidReply(raw, parsed.issues, parsed.reason);
    if (parsed.message.type !== 'TTS_SPEAK') {
      return failure(INVALID_REQUEST_CODE, 'speechInvalidRequest', 'Invalid request.');
    }
    const { requestId, text, lang, rate } = parsed.message;

    targets.set(requestId, { tabId: sender.tab?.id, frameId: sender.frameId });
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
  }

  async function stop(raw: unknown, sender: SenderLike): Promise<MessageReply<TtsStopReplyData>> {
    if (!fromThisExtension(sender)) {
      return failure('PERMISSION_DENIED', undefined, 'Not allowed.', requestIdOf(raw));
    }
    const parsed = parsePublicMessage(raw);
    if (!parsed.ok || parsed.message.type !== 'TTS_STOP') {
      return failure(
        INVALID_REQUEST_CODE,
        'speechInvalidRequest',
        'Invalid request.',
        requestIdOf(raw),
      );
    }
    const requestId = parsed.message.requestId;
    const stopped = await service.stop(requestId);
    return { ok: true, ...(requestId === undefined ? {} : { requestId }), data: { stopped } };
  }

  async function diagnose(sender: SenderLike): Promise<MessageReply<SpeechDiagnoseReplyData>> {
    if (!fromExtensionPage(sender)) {
      return failure('PERMISSION_DENIED', undefined, 'Extension pages only.');
    }
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
  }

  return function route(raw: unknown, sender: SenderLike): Promise<unknown> | undefined {
    switch (messageType(raw)) {
      case 'TTS_SPEAK':
        return speak(raw, sender);
      case 'TTS_STOP':
        return stop(raw, sender);
      case 'SPEECH_DIAGNOSE':
        return speechDiagnoseSchema.safeParse(raw).success ? diagnose(sender) : IGNORED;
      case 'SPEECH_OFFSCREEN_EVENT': {
        const event = offscreenEventSchema.safeParse(raw);
        if (event.success && fromOffscreenPage(sender)) {
          deps.offscreenEngine.handlePageEvent(event.data);
        }
        return IGNORED;
      }
      case 'SPEECH_OFFSCREEN_IDLE':
        if (offscreenIdleSchema.safeParse(raw).success && fromOffscreenPage(sender)) {
          deps.offscreenEngine.handlePageIdle();
        }
        return IGNORED;
      default:
        return IGNORED;
    }
  };
}

/**
 * Called once, synchronously, from the service worker at startup (MV3 requires
 * listeners to be registered in the first turn). Nothing here awaits.
 *
 * Phase 6 design notes (Spike D):
 * - The service lives in the worker's memory. If the worker is torn down mid
 *   utterance, chrome.tts keeps speaking but tracking is lost; a Stop without a
 *   requestId therefore stops every engine, tracked or not.
 * - State events are pushed with tabs.sendMessage (frame-targeted) to the tab
 *   that asked, or runtime.sendMessage for tab-less extension pages (popup).
 * - Phase 3's central router should call `createSpeechRouter(...)` instead of
 *   adding a second listener, and TTS_EVENT / the offscreen messages should be
 *   promoted into lib/contracts.
 */
export function registerSpeech(): void {
  const offscreenPageUrl = browser.runtime.getURL(OFFSCREEN_PAGE_PATH);
  const offscreenEngine = new OffscreenSpeechEngine({ host: createOffscreenHost() });
  const service = new SpeechService({ engines: [new ChromeTtsEngine(), offscreenEngine] });

  const route = createSpeechRouter({
    service,
    offscreenEngine,
    runtimeId: browser.runtime.id,
    extensionUrlPrefix: new URL('/', offscreenPageUrl).href,
    offscreenPageUrl,
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

  browser.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
    const pending = route(raw, sender);
    if (pending === undefined) return undefined;
    void pending.then(sendResponse);
    return true;
  });
}
