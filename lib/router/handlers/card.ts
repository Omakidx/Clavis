import { EXPLAIN_CARD_SCRIPT_FILE } from '../../config/constants';
import type { LoadExplainCardResult, MessageReply } from '../../contracts';
import { logger } from '../../security/logger';
import {
  classifyInjectError,
  isInjectableUrl,
  type InjectionDeps,
} from '../../site-access/injection';
import { failure, success } from '../replies';
import type { RouteContext } from '../router';

export interface CardLoaderDeps {
  scripting: InjectionDeps['scripting'];
  /** Manifest-relative path of the built card script. */
  file?: string;
}

/** `about:blank` / `about:srcdoc` frames of a web page run the observer too (matchOriginAsFallback). */
function isCardInjectable(url: string | undefined): boolean {
  if (url === 'about:blank' || url === 'about:srcdoc') return true;
  return url !== undefined && url !== '' && isInjectableUrl(url);
}

type LoadReply = MessageReply<LoadExplainCardResult>;

/**
 * LOAD_EXPLAIN_CARD: inject the card script (D-08, loaded on the first Explain, never with the
 * observer) into exactly the sender's frame: `target: { tabId, frameIds: [frameId] }`, both read
 * from the browser-provided sender, never from the message. The card script is a content script
 * bundle that guards itself with an isolated-world global, so injecting twice is harmless; the
 * handler also avoids it: one injection per document (`documentId` changes on navigation), and
 * concurrent requests for the same frame share one `executeScript` call.
 */
export function createCardHandlers(deps: CardLoaderDeps) {
  const file = deps.file ?? EXPLAIN_CARD_SCRIPT_FILE;
  const pending = new Map<string, Promise<LoadReply>>();

  async function inject(tabId: number, frameId: number, documentId: string | undefined) {
    try {
      await deps.scripting.executeScript({
        // The exact document when Chrome told us which: a frame that navigated while this request
        // was in flight must not get the card in its NEXT document. Chrome 147+ always reports it.
        target:
          documentId === undefined
            ? { tabId, frameIds: [frameId] }
            : { tabId, documentIds: [documentId] },
        // Typed as WXT's generated public paths in the injection module; the card entrypoint
        // belongs to another workstream, so the path is a plain string constant here.
        files: [file as never],
      });
    } catch (error) {
      const reason = classifyInjectError(error);
      logger.warn('card_load_failed', { errorCode: reason });
      if (reason === 'restricted') return failure('UNSUPPORTED_SITE');
      if (reason === 'no-access') return failure('PERMISSION_DENIED');
      return failure('INTERNAL_ERROR');
    }
    return success<LoadExplainCardResult>({ loaded: true });
  }

  return {
    async loadExplainCard(context: RouteContext): Promise<LoadReply> {
      const { tabId, frameId, documentId, url } = context.sender;
      // A content script always has a tab and a frame; anything else is not a page we can target.
      if (tabId === undefined || frameId === undefined) return failure('INVALID_REQUEST');
      if (!isCardInjectable(url)) return failure('UNSUPPORTED_SITE');
      const key = documentId ?? `${tabId}:${frameId}`;
      const inFlight = pending.get(key);
      if (inFlight !== undefined) return inFlight;
      const run = inject(tabId, frameId, documentId).finally(() => pending.delete(key));
      pending.set(key, run);
      return run;
    },
  };
}

export type CardHandlers = ReturnType<typeof createCardHandlers>;
