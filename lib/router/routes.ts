import { EXTENSION_PAGES } from '../config/constants';
import {
  parsePrivilegedMessage,
  parsePublicMessage,
  parseSidePanelMessage,
  type MessageParseResult,
  type PrivilegedMessage,
  type PublicMessage,
  type SidePanelMessage,
} from '../contracts';
import {
  parseLibraryMessage,
  parseWordMessage,
  type LibraryMessage,
  type WordMessage,
} from '../contracts/words';
import { parseAccountMessage, type AccountMessage } from '../contracts/account';
import { parseDocumentMessage, type DocumentMessage } from '../contracts/documents';
import { injectTabForPopup, type InjectionDeps } from '../site-access/injection';
import { isInjectTabMessage, type InjectTabMessage } from '../site-access/messages';
import { rejectedSpeakReply, type SpeechHandlers } from '../speech/background';
import type { createAiHandlers } from './handlers/ai';
import type { CardHandlers } from './handlers/card';
import type { NavigationHandlers } from './handlers/navigation';
import type { ChatHandlers } from './handlers/chat';
import type { SidePanelHandlers } from './handlers/sidepanel';
import type { AccountHandlers } from './handlers/account';
import type { DocumentHandlers } from './handlers/documents';
import type { SyncHandlers } from './handlers/sync';
import type { WordHandlers } from './handlers/words';
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
import { panelTabOf, PRACTICE_PAGE_PATH } from './sender';

// ---------------------------------------------------------------------------
// Allowed senders
// ---------------------------------------------------------------------------

const { options, onboarding, popup, reader, sidepanel, library } = EXTENSION_PAGES;

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
 * AI_EXPLAIN (further modes on demand) and AI_CANCEL: the contexts that host the explanation card
 * (web page content scripts, the reader and the practice page) and the side panel (FR-042). Not
 * Settings, onboarding or the popup: they never send these, so a paid Groq request can be started
 * by nothing but a card. The panel never carries `acknowledgeDisclosure`: that stays with the card
 * (`mayAcknowledgeDisclosure`), so the panel adds no new disclosure path.
 */
export const AI_SENDERS: SenderRule = {
  content: true,
  pages: [reader, PRACTICE_PAGE_PATH, sidepanel],
};

/**
 * TTS_SPEAK / TTS_STOP (Listen for the selected text; Settings "Test voice" speaks from Settings
 * and onboarding) and GET_PUBLIC_SETTINGS (rate, language). Not GET_AI_STATUS.
 */
export const PANEL_SENDERS: SenderRule = {
  content: true,
  pages: [options, onboarding, popup, reader, PRACTICE_PAGE_PATH, sidepanel],
};

/**
 * Who may send TTS_SPEAK with an explicit `voiceName` (Settings "Test voice"): Settings and
 * onboarding only. The voice Listen uses everywhere else comes from the saved settings in the
 * background, so a page-side content script cannot override the saved voice or Automatic policy.
 */
export const VOICE_NAME_SENDERS: readonly string[] = [options, onboarding];

/**
 * OPEN_SIDE_PANEL: the contexts that host the explanation card (web page content scripts, the
 * reader and the practice page). Not the popup, Settings or the panel itself.
 */
export const OPEN_SIDE_PANEL_SENDERS: SenderRule = {
  content: true,
  pages: [reader, PRACTICE_PAGE_PATH],
};

/** GET_SIDE_PANEL_STATE: the side panel only, and only for its own tab (checked in the route). */
export const GET_SIDE_PANEL_STATE_SENDERS: SenderRule = { pages: [sidepanel] };

/**
 * Key routes (KEY_ROUTES in lib/contracts) and CLEAR_ALL_DATA: ONLY the options and
 * onboarding pages (Phase 2 review LOW-5). Never the reader (it renders untrusted PDFs),
 * the popup, the practice page or a content script.
 */
export const KEY_SENDERS: SenderRule = { pages: [options, onboarding] };

/**
 * LOAD_EXPLAIN_CARD / LOAD_TOOLBAR: website content scripts only. They inject into the SENDER's own frame, so a
 * page that is not ours (the reader, the practice page) has nothing to load, and no extension
 * page may inject a script into a tab on a content script's behalf.
 */
export const CARD_LOAD_SENDERS: SenderRule = { content: true };

/** OPEN_SETTINGS: where "Open settings" buttons live (the card, the practice page, the reader, the popup). */
export const OPEN_SETTINGS_SENDERS: SenderRule = {
  content: true,
  pages: [popup, reader, PRACTICE_PAGE_PATH, sidepanel],
};

/** Other privileged routes: settings and status. Adds the popup. */
export const SETTINGS_SENDERS: SenderRule = { pages: [options, onboarding, popup] };

/**
 * ACCEPT_DISCLOSURE: the settings senders plus the library, for that one route only. The library
 * shows the one-time "Send this to Groq?" copy before its first chat message (S-05); it gets no
 * other settings route.
 */
export const ACCEPT_DISCLOSURE_SENDERS: SenderRule = {
  pages: [options, onboarding, popup, library],
};

/**
 * SAVE_WORD, UNSAVE_WORD and GET_WORD_SAVED: the contexts that host the card (web page content
 * scripts, the reader and the practice page) and the side panel. Untrusted callers: the source of
 * a saved word is taken from the browser's sender fields, never from the message (handler).
 */
export const WORD_SENDERS: SenderRule = {
  content: true,
  pages: [reader, PRACTICE_PAGE_PATH, sidepanel],
};

/** WORD_CHAT_SEND and WORD_CHAT_CANCEL: the library only (S-05: new messages come from the extension). */
export const LIBRARY_SENDERS: SenderRule = { pages: [library] };

/** SYNC_KICK: the pages that write local data. */
export const SYNC_KICK_SENDERS: SenderRule = { pages: [reader, library, options] };

/** Account routes (docs/clavis-sync-design.md 7.4). Extension pages only, never a content script. */
export const ACCOUNT_STATUS_SENDERS: SenderRule = {
  pages: [options, onboarding, popup, reader, library],
};
export const ACCOUNT_SIGN_IN_SENDERS: SenderRule = { pages: [options, popup] };
export const ACCOUNT_SIGN_OUT_SENDERS: SenderRule = { pages: [options] };
export const ACCOUNT_SIGN_OUT_EVERYWHERE_SENDERS: SenderRule = { pages: [options] };
export const SYNC_NOW_SENDERS: SenderRule = { pages: [options, popup, library] };

/**
 * PDF files in the account (design 7.4). Upload and fetch are the reader's (it holds the file and
 * opens it); removing a stored file also belongs to the library's Documents tab. Never a content
 * script, the popup or the side panel.
 */
export const DOCUMENT_UPLOAD_SENDERS: SenderRule = { pages: [reader] };
export const DOCUMENT_FETCH_SENDERS: SenderRule = { pages: [reader] };
export const DOCUMENT_REMOVE_FILE_SENDERS: SenderRule = { pages: [reader, library] };

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

/**
 * A route of the side panel (FR-042): validated by `parseSidePanelMessage`, the only parser with
 * the larger size bound (`LIMITS.maxHandoffBytes`).
 */
function sidePanelRoute<K extends SidePanelMessage['type']>(
  type: K,
  allow: SenderRule,
  handle: (message: Extract<SidePanelMessage, { type: K }>, context: RouteContext) => unknown,
): Route {
  return defineRoute<Extract<SidePanelMessage, { type: K }>>({
    type,
    allow,
    parse: (raw) => {
      const parsed = parseSidePanelMessage(raw);
      return parsed.ok && parsed.message.type === type
        ? { ok: true, message: parsed.message as Extract<SidePanelMessage, { type: K }> }
        : { ok: false };
    },
    handle,
  });
}

/** A word route (SAVE_WORD, UNSAVE_WORD, GET_WORD_SAVED): validated by `parseWordMessage`. */
function wordRoute<K extends WordMessage['type']>(
  type: K,
  handle: (message: Extract<WordMessage, { type: K }>, context: RouteContext) => unknown,
): Route {
  return defineRoute<Extract<WordMessage, { type: K }>>({
    type,
    allow: WORD_SENDERS,
    parse: contract<WordMessage, K>(parseWordMessage, type),
    handle,
  });
}

/** A route of the library family (chat, sync nudge): validated by `parseLibraryMessage`. */
function libraryRoute<K extends LibraryMessage['type']>(
  type: K,
  allow: SenderRule,
  handle: (message: Extract<LibraryMessage, { type: K }>, context: RouteContext) => unknown,
): Route {
  return defineRoute<Extract<LibraryMessage, { type: K }>>({
    type,
    allow,
    parse: contract<LibraryMessage, K>(parseLibraryMessage, type),
    handle,
  });
}

/** A route of the account family (ACCOUNT_*, SYNC_NOW): validated by `parseAccountMessage`. */
function accountRoute<K extends AccountMessage['type']>(
  type: K,
  allow: SenderRule,
  handle: (message: Extract<AccountMessage, { type: K }>, context: RouteContext) => unknown,
): Route {
  return defineRoute<Extract<AccountMessage, { type: K }>>({
    type,
    allow,
    parse: contract<AccountMessage, K>(parseAccountMessage, type),
    handle,
  });
}

/** A route of the document family (DOCUMENT_*): validated by `parseDocumentMessage`. */
function documentRoute<K extends DocumentMessage['type']>(
  type: K,
  allow: SenderRule,
  handle: (message: Extract<DocumentMessage, { type: K }>, context: RouteContext) => unknown,
): Route {
  return defineRoute<Extract<DocumentMessage, { type: K }>>({
    type,
    allow,
    parse: contract<DocumentMessage, K>(parseDocumentMessage, type),
    handle,
  });
}

/** The Spike B replies are `{ ok: false, reason }`, not envelopes; keep that shape. */
const injectRejected = (): unknown => ({ ok: false, reason: 'failed' });

export interface RouteServices {
  ai: ReturnType<typeof createAiHandlers>;
  card: CardHandlers;
  navigation: NavigationHandlers;
  sidePanel: SidePanelHandlers;
  keys: KeyService;
  settings: SettingsHandlers;
  speech: SpeechHandlers;
  injection: InjectionDeps;
  words: WordHandlers;
  chat: ChatHandlers;
  sync: SyncHandlers;
  account: AccountHandlers;
  documents: DocumentHandlers;
}

/**
 * The route table: the single place that says which message type may be sent by whom.
 * Anything not listed is not answered.
 */
export function buildRoutes(services: RouteServices): Route[] {
  const {
    ai,
    card,
    navigation,
    sidePanel,
    keys,
    settings,
    speech,
    injection,
    words,
    chat,
    sync,
    account,
    documents,
  } = services;

  return [
    // ---- public ---------------------------------------------------------
    publicRoute(
      'AI_EXPLAIN',
      (message, context) =>
        ai.explain(message.payload, context, {
          acknowledgeDisclosure: message.acknowledgeDisclosure === true,
        }),
      { allow: AI_SENDERS },
    ),
    publicRoute('AI_CANCEL', (message, context) => ai.cancel(message.requestId, context), {
      allow: AI_SENDERS,
    }),
    publicRoute(
      'TTS_SPEAK',
      (message, { sender }) => {
        // An explicit voice is Settings' "Test voice" only; anyone else's is refused outright.
        if (
          message.voiceName !== undefined &&
          !(sender.kind === 'extension' && VOICE_NAME_SENDERS.includes(sender.path ?? ''))
        ) {
          return rejectedSpeakReply(message);
        }
        return speech.speak(message, {
          tabId: sender.tabId,
          frameId: sender.frameId,
          documentId: sender.documentId,
        });
      },
      {
        allow: PANEL_SENDERS,
        reject: (raw, why) => (why === 'shape' ? rejectedSpeakReply(raw) : invalidRequest(raw)),
      },
    ),
    publicRoute(
      'TTS_STOP',
      (message, { sender }) =>
        speech.stop(message, { tabId: sender.tabId, frameId: sender.frameId }),
      { allow: PANEL_SENDERS },
    ),
    publicRoute('GET_PUBLIC_SETTINGS', () => ai.getPublicSettings(), { allow: PANEL_SENDERS }),
    publicRoute('GET_AI_STATUS', () => ai.getAiStatus()),
    publicRoute('LOAD_EXPLAIN_CARD', (_message, context) => card.loadExplainCard(context), {
      allow: CARD_LOAD_SENDERS,
    }),
    publicRoute('LOAD_TOOLBAR', (_message, context) => card.loadToolbar(context), {
      allow: CARD_LOAD_SENDERS,
    }),
    publicRoute(
      'OPEN_SETTINGS',
      (message, context) => navigation.openSettings(message.section, context),
      { allow: OPEN_SETTINGS_SENDERS },
    ),

    // ---- the side panel (FR-042) ------------------------------------------------
    // The hand-off is the one message above the normal size bound; it is held in memory by tab.
    sidePanelRoute('OPEN_SIDE_PANEL', OPEN_SIDE_PANEL_SENDERS, (message, context) =>
      sidePanel.open(message.handoff, context),
    ),
    sidePanelRoute('GET_SIDE_PANEL_STATE', GET_SIDE_PANEL_STATE_SENDERS, (message, context) =>
      // A panel reads only its own tab's hand-off (the tab id in its own url, set by us).
      panelTabOf(context.sender.url) === message.tabId
        ? sidePanel.getState(message.tabId)
        : invalidRequest(message),
    ),

    // ---- saved words (docs/clavis-sync-design.md 7.4) ---------------------------------
    wordRoute('SAVE_WORD', (message, context) => words.save(message, context)),
    wordRoute('UNSAVE_WORD', (message, context) => words.unsave(message.wordKey, context)),
    wordRoute('GET_WORD_SAVED', (message, context) => words.isSaved(message.text, context)),

    // ---- the library: chat about a saved word, and the sync nudge ----------------------
    libraryRoute('WORD_CHAT_SEND', LIBRARY_SENDERS, (message) => chat.send(message)),
    libraryRoute('WORD_CHAT_CANCEL', LIBRARY_SENDERS, (message) => chat.cancel(message.requestId)),
    libraryRoute('SYNC_KICK', SYNC_KICK_SENDERS, (message) => sync.kick(message.pull === true)),

    // ---- account and sync (docs/clavis-sync-design.md 7.4) ---------------------------
    accountRoute('ACCOUNT_GET_STATUS', ACCOUNT_STATUS_SENDERS, () => account.getStatus()),
    accountRoute('ACCOUNT_SIGN_IN', ACCOUNT_SIGN_IN_SENDERS, () => account.signIn()),
    accountRoute('ACCOUNT_SIGN_OUT', ACCOUNT_SIGN_OUT_SENDERS, (message) =>
      account.signOut(message.keepLocalCopy),
    ),
    accountRoute('ACCOUNT_SIGN_OUT_EVERYWHERE', ACCOUNT_SIGN_OUT_EVERYWHERE_SENDERS, () =>
      account.signOutEverywhere(),
    ),
    accountRoute('SYNC_NOW', SYNC_NOW_SENDERS, () => account.syncNow()),

    // ---- PDF files in the account (docs/clavis-sync-design.md 6.6, 7.4) ---------------
    documentRoute('DOCUMENT_UPLOAD', DOCUMENT_UPLOAD_SENDERS, (message) =>
      documents.upload(message),
    ),
    documentRoute('DOCUMENT_FETCH', DOCUMENT_FETCH_SENDERS, (message) =>
      documents.fetchFile(message),
    ),
    documentRoute('DOCUMENT_REMOVE_FILE', DOCUMENT_REMOVE_FILE_SENDERS, (message) =>
      documents.removeFile(message),
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
    privilegedRoute('ACCEPT_DISCLOSURE', ACCEPT_DISCLOSURE_SENDERS, () =>
      settings.acceptDisclosure(),
    ),
    privilegedRoute('UPDATE_ONBOARDING', SETTINGS_SENDERS, (message) =>
      settings.updateOnboarding({
        completed: message.completed,
        siteAccessChoice: message.siteAccessChoice,
      }),
    ),
    privilegedRoute('GET_SITE_ACCESS_STATUS', SETTINGS_SENDERS, () =>
      settings.getSiteAccessStatus(),
    ),
    // Which voices this device has (Settings voice chooser).
    privilegedRoute('GET_VOICES', SETTINGS_SENDERS, () => speech.getVoices()),

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
  ];
}
