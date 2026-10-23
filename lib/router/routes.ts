import { EXTENSION_PAGES } from '../config/constants';
import {
  parsePrivilegedMessage,
  parsePublicMessage,
  type MessageParseResult,
  type PrivilegedMessage,
  type PublicMessage,
} from '../contracts';
import { injectTabForPopup, type InjectionDeps } from '../site-access/injection';
import { isInjectTabMessage, type InjectTabMessage } from '../site-access/messages';
import {
  type OffscreenEventMessage,
  offscreenEventSchema,
  offscreenIdleSchema,
  speechDiagnoseSchema,
} from '../speech/messages';
import { rejectedSpeakReply, type SpeechHandlers } from '../speech/background';
import type { createAiHandlers } from './handlers/ai';
import type { CardHandlers } from './handlers/card';
import type { NavigationHandlers } from './handlers/navigation';
import type { KeyService } from './handlers/key';
import type { SettingsHandlers } from './handlers/settings';
import {
  defineRoute,
  parseWith,
  type ParseResult,
  type Route,
  type RouteContext,
  type SenderRule,
} from './router';
import { invalidRequest } from './replies';
import { PRACTICE_PAGE_PATH } from './sender';

// ---------------------------------------------------------------------------
// Allowed senders
// ---------------------------------------------------------------------------

const { options, onboarding, popup, reader } = EXTENSION_PAGES;

/**
 * Public routes: content scripts, the reader, the practice page and the other extension
 * pages. Untrusted callers (a content script lives next to a hostile page), so every
 * public handler treats its input as hostile.
 */
export const PUBLIC_SENDERS: SenderRule = {
  content: true,
  pages: [options, onboarding, popup, reader, PRACTICE_PAGE_PATH],
};

/**
 * Key routes (KEY_ROUTES in lib/contracts) and CLEAR_ALL_DATA: ONLY the options and
 * onboarding pages (Phase 2 review LOW-5). Never the reader (it renders untrusted PDFs),
 * the popup, the practice page, a content script or the offscreen document.
 */
export const KEY_SENDERS: SenderRule = { pages: [options, onboarding] };

/**
 * LOAD_EXPLAIN_CARD: website content scripts only. It injects into the SENDER's own frame, so a
 * page that is not ours (the reader, the practice page) has nothing to load, and no extension
 * page may inject a script into a tab on a content script's behalf.
 */
export const CARD_LOAD_SENDERS: SenderRule = { content: true };

/** OPEN_SETTINGS: where "Open settings" buttons live (the card, the practice page, the reader, the popup). */
export const OPEN_SETTINGS_SENDERS: SenderRule = {
  content: true,
  pages: [popup, reader, PRACTICE_PAGE_PATH],
};

/** Other privileged routes: settings and status. Adds the popup. */
export const SETTINGS_SENDERS: SenderRule = { pages: [options, onboarding, popup] };

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

/** Parse with a contract parser and require the given type (the parsers accept a whole union). */
function contract<U extends { type: string }, K extends U['type']>(
  parse: (raw: unknown) => MessageParseResult<U>,
  type: K,
): (raw: unknown) => ParseResult<Extract<U, { type: K }>> {
  return (raw) => {
    const parsed = parse(raw);
    return parsed.ok && parsed.message.type === type
      ? { ok: true, message: parsed.message as Extract<U, { type: K }> }
      : { ok: false };
  };
}

type PublicOf<K extends PublicMessage['type']> = Extract<PublicMessage, { type: K }>;
type PrivilegedOf<K extends PrivilegedMessage['type']> = Extract<PrivilegedMessage, { type: K }>;

interface RouteExtras {
  reject?: (raw: unknown, why: 'sender' | 'shape') => unknown;
}

/** A route whose message is validated by the public contract parser. */
function publicRoute<K extends PublicMessage['type']>(
  type: K,
  handle: (message: PublicOf<K>, context: RouteContext) => unknown,
  extras: RouteExtras & { allow?: SenderRule } = {},
): Route {
  const { allow = PUBLIC_SENDERS, ...rest } = extras;
  return defineRoute<PublicOf<K>>({
    type,
    allow,
    parse: contract<PublicMessage, K>(parsePublicMessage, type),
    handle,
    ...rest,
  });
}

/** A route whose message is validated by the privileged contract parser. */
function privilegedRoute<K extends PrivilegedMessage['type']>(
  type: K,
  allow: SenderRule,
  handle: (message: PrivilegedOf<K>, context: RouteContext) => unknown,
): Route {
  return defineRoute<PrivilegedOf<K>>({
    type,
    allow,
    parse: contract<PrivilegedMessage, K>(parsePrivilegedMessage, type),
    handle,
  });
}

/** The Spike B replies are `{ ok: false, reason }`, not envelopes; keep that shape. */
const injectRejected = (): unknown => ({ ok: false, reason: 'failed' });

export interface RouteServices {
  ai: ReturnType<typeof createAiHandlers>;
  card: CardHandlers;
  navigation: NavigationHandlers;
  keys: KeyService;
  settings: SettingsHandlers;
  speech: SpeechHandlers;
  injection: InjectionDeps;
}

/**
 * The route table: the single place that says which message type may be sent by whom.
 * Anything not listed is not answered.
 */
export function buildRoutes(services: RouteServices): Route[] {
  const { ai, card, navigation, keys, settings, speech, injection } = services;

  return [
    // ---- public ---------------------------------------------------------
    publicRoute('AI_EXPLAIN', (message, context) =>
      ai.explain(message.payload, context, {
        acknowledgeDisclosure: message.acknowledgeDisclosure === true,
      }),
    ),
    publicRoute('AI_CANCEL', (message, context) => ai.cancel(message.requestId, context)),
    publicRoute(
      'TTS_SPEAK',
      (message, { sender }) =>
        speech.speak(message, { tabId: sender.tabId, frameId: sender.frameId }),
      { reject: (raw, why) => (why === 'shape' ? rejectedSpeakReply(raw) : invalidRequest(raw)) },
    ),
    publicRoute('TTS_STOP', (message, { sender }) =>
      speech.stop(message, { tabId: sender.tabId, frameId: sender.frameId }),
    ),
    publicRoute('GET_PUBLIC_SETTINGS', () => ai.getPublicSettings()),
    publicRoute('GET_AI_STATUS', () => ai.getAiStatus()),
    publicRoute('LOAD_EXPLAIN_CARD', (_message, context) => card.loadExplainCard(context), {
      allow: CARD_LOAD_SENDERS,
    }),
    publicRoute(
      'OPEN_SETTINGS',
      (message, context) => navigation.openSettings(message.section, context),
      { allow: OPEN_SETTINGS_SENDERS },
    ),

    // ---- privileged: the key --------------------------------------------
    privilegedRoute('SET_API_KEY', KEY_SENDERS, (message) =>
      keys.set(message.apiKey, message.storage),
    ),
    privilegedRoute('TEST_API_KEY', KEY_SENDERS, () => keys.test()),
    privilegedRoute('REMOVE_API_KEY', KEY_SENDERS, () => keys.remove()),
    privilegedRoute('GET_KEY_STATUS', KEY_SENDERS, () => keys.getStatus()),
    privilegedRoute('CLEAR_ALL_DATA', KEY_SENDERS, () => settings.clearAllData()),

    // ---- privileged: settings and status -----------------------------------
    privilegedRoute('GET_SETTINGS', SETTINGS_SENDERS, () => settings.getSettings()),
    privilegedRoute('UPDATE_PREFERENCES', SETTINGS_SENDERS, (message) =>
      settings.updatePreferences(message.patch),
    ),
    privilegedRoute('RESET_PREFERENCES', SETTINGS_SENDERS, () => settings.resetPreferences()),
    privilegedRoute('ACCEPT_DISCLOSURE', SETTINGS_SENDERS, () => settings.acceptDisclosure()),
    privilegedRoute('UPDATE_ONBOARDING', SETTINGS_SENDERS, (message) =>
      settings.updateOnboarding({
        completed: message.completed,
        siteAccessChoice: message.siteAccessChoice,
      }),
    ),
    privilegedRoute('GET_SITE_ACCESS_STATUS', SETTINGS_SENDERS, () =>
      settings.getSiteAccessStatus(),
    ),

    // ---- internal: site access (Spike B messages, plain objects by design) ------
    defineRoute<InjectTabMessage>({
      type: 'CLAVIS_INJECT_TAB',
      // Popup "Explain on this page" (activeTab). It can inject into any tab, so popup only.
      allow: { pages: [popup] },
      parse: parseWith<InjectTabMessage>((raw) =>
        isInjectTabMessage(raw) ? { success: true, data: raw } : { success: false },
      ),
      handle: (message) => injectTabForPopup(injection, message),
      reject: injectRejected,
    }),

    // ---- internal: speech ----------------------------------------------------
    defineRoute({
      type: 'SPEECH_DIAGNOSE',
      // Spike-only diagnostics (removed before release, Phase 6).
      allow: { pages: [popup, options, onboarding] },
      parse: parseWith((raw) => speechDiagnoseSchema.safeParse(raw)),
      handle: () => speech.diagnose(),
    }),
    defineRoute<OffscreenEventMessage>({
      type: 'SPEECH_OFFSCREEN_EVENT',
      allow: { offscreen: true },
      parse: parseWith<OffscreenEventMessage>((raw) => offscreenEventSchema.safeParse(raw)),
      handle: (message) => speech.offscreenEvent(message),
      replies: false,
    }),
    defineRoute({
      type: 'SPEECH_OFFSCREEN_IDLE',
      allow: { offscreen: true },
      parse: parseWith((raw) => offscreenIdleSchema.safeParse(raw)),
      handle: () => speech.offscreenIdle(),
      replies: false,
    }),
  ];
}
