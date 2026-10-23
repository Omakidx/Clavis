import { browser } from 'wxt/browser';
import { MESSAGE_VERSION } from '../../lib/config/constants';
import {
  messageReplySchema,
  sidePanelStateSchema,
  sidePanelUpdatedMessageSchema,
  tabIdSchema,
  type SidePanelState,
} from '../../lib/contracts';

/**
 * The side panel's side of the hand-off (FR-042): ask the service worker what is waiting for this
 * panel's tab, and hear when it changes. Everything that comes back is untrusted TEXT for the
 * panel (a web page chose the selection, a model wrote the answer): it is validated here and then
 * only ever rendered as text nodes (D-10).
 */

const stateReply = messageReplySchema(sidePanelStateSchema);

/** The tab this panel belongs to: the service worker put it in the panel's path (`?tab=7`). */
export function tabFromSearch(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('tab');
  if (raw === null || !/^\d{1,10}$/.test(raw)) return undefined;
  const parsed = tabIdSchema.safeParse(Number(raw));
  return parsed.success ? parsed.data : undefined;
}

/** `null` handoff: nothing is held for the tab (worker restarted, page left, cleared, never sent). */
export const NOTHING: SidePanelState = { revision: -1, handoff: null };

export interface PanelClient {
  /** What is waiting for `tabId`. Never rejects: an unanswered or invalid reply means "nothing". */
  fetchState(tabId: number): Promise<SidePanelState>;
  /** Call `listener` when the hand-off of `tabId` changed. Returns the unsubscribe function. */
  onUpdated(tabId: number, listener: () => void): () => void;
}

/** The sender fields the check reads (a subset of `runtime.MessageSender`). */
interface SenderLike {
  id?: string | undefined;
  url?: string | undefined;
  tab?: unknown;
}

/**
 * Messages this page accepts come from the service worker only: our id, no tab (a content script
 * has one) and the worker's own script url (as in the reader, Phase 7 review LOW-3).
 */
export function isFromBackground(sender: SenderLike | undefined): boolean {
  return (
    sender?.id === browser.runtime.id &&
    sender.tab === undefined &&
    sender.url === browser.runtime.getURL('/background.js')
  );
}

export function createPanelClient(): PanelClient {
  const ask = async (tabId: number): Promise<SidePanelState | undefined> => {
    try {
      const reply: unknown = await browser.runtime.sendMessage({
        v: MESSAGE_VERSION,
        type: 'GET_SIDE_PANEL_STATE',
        tabId,
      });
      const parsed = stateReply.safeParse(reply);
      return parsed.success && parsed.data.ok ? parsed.data.data : undefined;
    } catch {
      return undefined;
    }
  };
  return {
    async fetchState(tabId) {
      // A service worker that was asleep may not have its listener up for the very first message.
      const first = await ask(tabId);
      if (first !== undefined) return first;
      await new Promise((resolve) => setTimeout(resolve, 400));
      return (await ask(tabId)) ?? NOTHING;
    },
    onUpdated(tabId, listener) {
      const onMessage = (message: unknown, sender: SenderLike | undefined): undefined => {
        if (!isFromBackground(sender)) return undefined;
        const parsed = sidePanelUpdatedMessageSchema.safeParse(message);
        if (parsed.success && parsed.data.tabId === tabId) listener();
        return undefined;
      };
      browser.runtime.onMessage.addListener(onMessage);
      return () => browser.runtime.onMessage.removeListener(onMessage);
    },
  };
}
