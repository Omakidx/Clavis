import { wordKey as computeWordKey } from '../../../shared/api-contract/words';
import { WordData, type WordSource } from '../../../shared/api-contract/records';
import { EXTENSION_PAGES } from '../../config/constants';
import type { MessageReply } from '../../contracts';
import type { WordMessage } from '../../contracts/words';
import type { LocalWord } from '../../data/db';
import { deleteWord, getWord, putWord } from '../../data/words';
import { TokenBuckets, senderKey } from '../limiter';
import { failure, success } from '../replies';
import { clipUnits } from '../../pdf/state';
import type { RouteContext } from '../router';
import { PRACTICE_PAGE_PATH, panelTabOf, type ClassifiedSender } from '../sender';

/**
 * SAVE_WORD, UNSAVE_WORD and GET_WORD_SAVED (docs/clavis-sync-design.md 7.4). Everything a saved
 * word says about where it came from is decided here, from what the browser reports about the
 * sender, never from the message body, because a content script lives next to a hostile page.
 */

type Saved = { wordKey: string };

/** At most this many saves per minute from one sender (a loop in a page cannot fill the store). */
const SAVE_RATE = { capacity: 30, windowMs: 60_000, maxTrackedSenders: 256 } as const;
/** Content scripts: UNSAVE like SAVE, and GET_WORD_SAVED more generously (the card asks on every lookup). */
const UNSAVE_RATE = SAVE_RATE;
const LOOKUP_RATE = { capacity: 60, windowMs: 60_000, maxTrackedSenders: 256 } as const;
const MAX_SOURCE_URL_CHARS = 2048;
const MAX_SOURCE_TITLE_CHARS = 300;

export interface WordHandlerDeps {
  /** Reads a tab's address and title (the side panel's source). */
  tabs: {
    get(tabId: number): Promise<{
      url?: string | undefined;
      title?: string | undefined;
      incognito?: boolean | undefined;
    }>;
  };
  now?: () => number;
}

/** A page address reduced to origin + path: no query, fragment or credentials (design 7.4). */
export function reduceUrl(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const reduced = `${url.origin}${url.pathname}`;
    return reduced.length <= MAX_SOURCE_URL_CHARS ? reduced : null;
  } catch {
    return null;
  }
}

/** Whole code points, at most 300 UTF-16 units (the shared limit): never half a surrogate pair. */
const clipTitle = (raw: string | undefined): string | null => {
  const title = raw?.replace(/\s+/gu, ' ').trim();
  return title === undefined || title === '' ? null : clipUnits(title, MAX_SOURCE_TITLE_CHARS);
};

/**
 * A content script may only touch words saved from a page of its own tab's origin (security review
 * M-1): the key is an unkeyed hash, so a compromised script could otherwise probe, delete or
 * overwrite any word. Extension senders are not limited.
 */
function mayTouch(word: LocalWord, sender: ClassifiedSender): boolean {
  if (sender.kind !== 'content') return true;
  const here = reduceUrl(sender.tabUrl);
  if (word.source.kind !== 'webpage' || word.source.url === null || here === null) return false;
  try {
    return new URL(word.source.url).origin === new URL(here).origin;
  } catch {
    return false;
  }
}

/**
 * The source of a save, or null when this sender may not say (or has no way to say) where it is.
 * - A content script: the webpage of its own tab, from `sender.tab`; a `pdf` part is refused.
 * - The reader: only the PDF it shows (`pdf` and `snapshot.page` are both required).
 * - The practice page: a webpage with no address.
 * - The side panel: the panel's own tab (`chrome.tabs.get`), or the PDF page the snapshot names.
 */
export async function deriveSource(
  message: Extract<WordMessage, { type: 'SAVE_WORD' }>,
  sender: ClassifiedSender,
  tabs: WordHandlerDeps['tabs'],
): Promise<WordSource | null> {
  const { snapshot, pdf } = message;
  if (sender.kind === 'content') {
    if (pdf !== undefined) return null;
    // Incognito: the word is kept, where it was read is not (security review L-2).
    if (sender.tabIncognito === true) return { kind: 'webpage', url: null, title: null };
    return { kind: 'webpage', url: reduceUrl(sender.tabUrl), title: clipTitle(sender.tabTitle) };
  }
  if (sender.kind !== 'extension') return null;
  switch (sender.path) {
    case EXTENSION_PAGES.reader:
      if (pdf === undefined || snapshot.source !== 'pdf' || snapshot.page === undefined)
        return null;
      return {
        kind: 'pdf',
        fingerprint: pdf.fingerprint,
        title: pdf.title === null ? null : clipTitle(pdf.title),
        page: snapshot.page,
      };
    case PRACTICE_PAGE_PATH:
      return pdf === undefined ? { kind: 'webpage', url: null, title: null } : null;
    case EXTENSION_PAGES.sidepanel: {
      if (pdf !== undefined) return null;
      // A selection made in the PDF reader keeps its page; the reader's own tab has no address to keep.
      if (snapshot.source === 'pdf' && snapshot.page !== undefined) {
        return { kind: 'pdf', fingerprint: null, title: null, page: snapshot.page };
      }
      const tabId = panelTabOf(sender.url);
      let tab: Awaited<ReturnType<WordHandlerDeps['tabs']['get']>> | undefined;
      try {
        tab = tabId === undefined ? undefined : await tabs.get(tabId);
      } catch {
        tab = undefined;
      }
      if (tab?.incognito === true) return { kind: 'webpage', url: null, title: null };
      return { kind: 'webpage', url: reduceUrl(tab?.url), title: clipTitle(tab?.title) };
    }
    default:
      return null;
  }
}

export function createWordHandlers(deps: WordHandlerDeps) {
  const now = deps.now ?? Date.now;
  const buckets = new TokenBuckets(SAVE_RATE, now);
  const unsaveBuckets = new TokenBuckets(UNSAVE_RATE, now);
  const lookupBuckets = new TokenBuckets(LOOKUP_RATE, now);

  return {
    async save(
      message: Extract<WordMessage, { type: 'SAVE_WORD' }>,
      context: RouteContext,
    ): Promise<MessageReply<Saved>> {
      const decision = buckets.take(senderKey(context.sender));
      if (!decision.ok) {
        return failure('RATE_LIMITED', {
          retryAfterMs: decision.retryAfterMs,
          reason: 'local-limit',
        });
      }
      const source = await deriveSource(message, context.sender, deps.tabs);
      if (source === null) return failure('INVALID_REQUEST');
      const { snapshot } = message;
      const candidate = {
        text: snapshot.text,
        ...(snapshot.languageHint === undefined ? {} : { language: snapshot.languageHint }),
        meaning: message.meaning,
        ...(snapshot.contextBefore === undefined || snapshot.contextBefore === ''
          ? {}
          : { contextBefore: snapshot.contextBefore }),
        ...(snapshot.contextAfter === undefined || snapshot.contextAfter === ''
          ? {}
          : { contextAfter: snapshot.contextAfter }),
        source,
        createdAt: now(),
      };
      // The same schema a push goes through: a record that is saved can always be synced.
      const parsed = WordData.safeParse(candidate);
      if (!parsed.success) return failure('INVALID_REQUEST');
      const key = await computeWordKey(parsed.data.text);
      // A content script never replaces a word saved from another origin or from a PDF. PERMISSION_DENIED
      // tells the card to say so (it keeps the word where it is: the Library manages it).
      const existing = await getWord(key);
      if (existing !== undefined && !mayTouch(existing, context.sender)) {
        return failure('PERMISSION_DENIED');
      }
      try {
        // P2: trigger sync from here (the background) after the write; card saves send no SYNC_KICK.
        await putWord(key, parsed.data, { now });
      } catch (error) {
        if (error instanceof Error && error.message === 'word-limit') {
          return failure('LIMIT_EXCEEDED');
        }
        throw error;
      }
      return success({ wordKey: key });
    },

    async unsave(
      wordKey: string,
      context: RouteContext,
    ): Promise<MessageReply<{ removed: boolean }>> {
      if (context.sender.kind === 'content') {
        const decision = unsaveBuckets.take(senderKey(context.sender));
        if (!decision.ok) {
          return failure('RATE_LIMITED', {
            retryAfterMs: decision.retryAfterMs,
            reason: 'local-limit',
          });
        }
        const word = await getWord(wordKey);
        // Not yours to remove looks the same as not saved: nothing is revealed or changed.
        if (word !== undefined && !mayTouch(word, context.sender))
          return failure('INVALID_REQUEST');
      }
      // P2: trigger sync from here (the background) after the delete; card unsaves send no SYNC_KICK.
      return success({ removed: await deleteWord(wordKey, { now }) });
    },

    async isSaved(
      text: string,
      context: RouteContext,
    ): Promise<MessageReply<{ saved: boolean; wordKey: string }>> {
      if (context.sender.kind === 'content') {
        const decision = lookupBuckets.take(senderKey(context.sender));
        if (!decision.ok) {
          return failure('RATE_LIMITED', {
            retryAfterMs: decision.retryAfterMs,
            reason: 'local-limit',
          });
        }
      }
      const key = await computeWordKey(text);
      const word = await getWord(key);
      // From a web page, a word saved elsewhere shows as not saved here.
      return success({
        saved: word !== undefined && mayTouch(word, context.sender),
        wordKey: key,
      });
    },
  };
}

export type WordHandlers = ReturnType<typeof createWordHandlers>;
