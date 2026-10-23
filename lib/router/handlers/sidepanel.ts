import { EXTENSION_PAGES, MESSAGE_VERSION } from '../../config/constants';
import type {
  MessageReply,
  OpenSidePanelResult,
  SidePanelHandoff,
  SidePanelState,
  SidePanelUpdatedMessage,
} from '../../contracts';
import { logger } from '../../security/logger';
import { failure, success } from '../replies';
import type { RouteContext } from '../router';

/**
 * The side panel hand-off (FR-042). The service worker holds, per TAB, the last explanation a card
 * sent for that tab, and serves it to that tab's side panel.
 *
 * Rules (docs/architecture.md section 3 and docs/decisions/p8-sidepanel-spike.md):
 * - In memory only. Never `chrome.storage`, never logged: it holds page text and model output. A
 *   worker restart loses it and the panel then says to select the text again.
 * - Keyed by the SENDER's tab (read from the browser-provided sender, never from the message), so
 *   one tab's explanation can only ever reach that tab's own panel (`path` carries the tab id and
 *   `setOptions({ tabId })` makes the panel exist for that tab only).
 * - Dropped when the tab closes, starts to load another page, or all data is cleared.
 * - Bounded: at most `MAX_TABS` tabs at once (oldest dropped first).
 * - `chrome.sidePanel.open()` needs a user gesture. A trusted click in the card reaches us as a
 *   runtime message, and Chrome carries the gesture only through the message event's own task: the
 *   panel is prepared and opened in the SAME synchronous turn, with nothing awaited before
 *   `open()`. An `await` first loses the gesture (measured, Chrome 156, real mouse).
 */

/** At most this many tabs hold a hand-off; the oldest is dropped first. */
export const MAX_HANDOFF_TABS = 24;
/** At least this long between two OPEN_SIDE_PANEL from one tab (a script cannot hammer it). */
export const OPEN_SIDE_PANEL_MIN_INTERVAL_MS = 300;

export interface SidePanelDeps {
  sidePanel: {
    setOptions(options: { tabId: number; path: string; enabled: boolean }): Promise<unknown>;
    open(options: { tabId: number }): Promise<unknown>;
  };
  /** Tell an open panel that the hand-off of a tab changed (a runtime broadcast; never any text). */
  notify(message: SidePanelUpdatedMessage): Promise<unknown>;
  now?: () => number;
}

/** The panel's path for one tab. The query is how the panel learns which tab it belongs to. */
export const sidePanelPath = (tabId: number): string =>
  `${EXTENSION_PAGES.sidepanel.slice(1)}?tab=${tabId}`;

export function createSidePanelHandlers(deps: SidePanelDeps) {
  const now = deps.now ?? Date.now;
  /** Insertion order = oldest first. */
  const held = new Map<number, SidePanelHandoff>();
  const lastOpened = new Map<number, number>();
  /** Tabs whose panel THIS worker enabled (so a refused open only rolls back what it did). */
  const enabled = new Set<number>();
  /** Counts every change (set or drop), so the panel can tell a new state from the one it shows. */
  let revision = 0;

  const tell = (tabId: number): void => {
    deps
      .notify({ v: MESSAGE_VERSION, type: 'SIDE_PANEL_UPDATED', tabId, revision })
      .catch(() => undefined); // No panel is listening: nothing to refresh.
  };

  /** Forget a tab's hand-off. The open throttle stays: a refused open must not reset it. */
  function drop(tabId: number): boolean {
    return held.delete(tabId);
  }

  /** The oldest tabs go once the bound is exceeded (called only after an open succeeded). */
  function evict(): void {
    while (held.size > MAX_HANDOFF_TABS) {
      const oldest = held.keys().next();
      if (oldest.done) break;
      drop(oldest.value);
      lastOpened.delete(oldest.value);
      enabled.delete(oldest.value);
    }
  }

  /**
   * Chrome refused (most likely: no user gesture). What this call put in memory goes again, and
   * the earlier hand-off of the tab, if it had one, stays. A panel that did not exist before is not
   * left enabled (it would offer an empty panel for the tab).
   */
  function undo(tabId: number, before: SidePanelHandoff | undefined): void {
    if (before !== undefined) {
      held.set(tabId, before);
      return;
    }
    drop(tabId);
    // Only disable a panel this call enabled; one that was already enabled stays as it was.
    if (enabled.has(tabId)) return;
    try {
      deps.sidePanel
        .setOptions({ tabId, path: sidePanelPath(tabId), enabled: false })
        .catch(() => undefined);
    } catch {
      // Best effort: the hand-off is gone either way.
    }
  }

  return {
    /**
     * OPEN_SIDE_PANEL. Everything up to the `open()` call is synchronous (see the header).
     */
    open(
      handoff: SidePanelHandoff,
      context: RouteContext,
    ): Promise<MessageReply<OpenSidePanelResult>> {
      const { tabId } = context.sender;
      // A card always has a tab; a tab-less sender has no panel to open.
      if (tabId === undefined) return Promise.resolve(failure('INVALID_REQUEST'));

      const at = now();
      const previous = lastOpened.get(tabId);
      if (previous !== undefined && at - previous < OPEN_SIDE_PANEL_MIN_INTERVAL_MS) {
        return Promise.resolve(
          failure('RATE_LIMITED', {
            retryAfterMs: Math.max(1, OPEN_SIDE_PANEL_MIN_INTERVAL_MS - (at - previous)),
            reason: 'local-limit',
          }),
        );
      }
      lastOpened.set(tabId, at);

      const before = held.get(tabId);
      held.delete(tabId);
      held.set(tabId, handoff);
      revision += 1;

      let prepared: Promise<unknown>;
      let opened: Promise<unknown>;
      try {
        // Same task as the message event: the panel exists for THIS tab only, then opens.
        prepared = deps.sidePanel.setOptions({
          tabId,
          path: sidePanelPath(tabId),
          enabled: true,
        });
        opened = deps.sidePanel.open({ tabId });
      } catch {
        undo(tabId, before);
        logger.warn('side_panel_open_failed');
        return Promise.resolve(failure('INTERNAL_ERROR'));
      }
      return Promise.all([prepared, opened]).then(
        () => {
          enabled.add(tabId);
          evict();
          // A panel that was already open shows the old explanation: tell it.
          tell(tabId);
          return success<OpenSidePanelResult>({ opened: true });
        },
        () => {
          undo(tabId, before);
          logger.warn('side_panel_open_failed');
          return failure('INTERNAL_ERROR');
        },
      );
    },

    /** GET_SIDE_PANEL_STATE: what is waiting for `tabId` (null: nothing, say "select again"). */
    getState(tabId: number): MessageReply<SidePanelState> {
      return success({ revision, handoff: held.get(tabId) ?? null });
    },

    /** The tab closed: forget its hand-off. */
    forget(tabId: number): void {
      drop(tabId);
      lastOpened.delete(tabId);
      enabled.delete(tabId);
    },

    /** The tab started loading another page: its explanation no longer belongs to what it shows. */
    reset(tabId: number): void {
      if (!drop(tabId)) return;
      revision += 1;
      tell(tabId);
    },

    /** CLEAR_ALL_DATA: nothing the user selected stays in memory. */
    clear(): void {
      const tabs = [...held.keys()];
      held.clear();
      lastOpened.clear();
      enabled.clear();
      revision += 1;
      for (const tabId of tabs) tell(tabId);
    },

    /** For tests: how many tabs hold a hand-off. */
    get size(): number {
      return held.size;
    },
  };
}

export type SidePanelHandlers = ReturnType<typeof createSidePanelHandlers>;
