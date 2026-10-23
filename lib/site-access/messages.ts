import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import { MESSAGE_VERSION } from '../config/constants';
import type { ShowNoticeMessage } from '../selection/notice';

/**
 * Internal messages between the observer, the background and the popup.
 *
 * Deliberately plain objects (no zod): the observer bundle is budgeted at 18 KB gzipped
 * (D-20). The background router (lib/router) validates them with the guards below and
 * checks the sender for every route.
 */

/** Extension page -> background: inject the observer (which bundles the toolbar, D-08) into a tab via `activeTab` (popup fallback). */
export interface InjectTabMessage {
  v: typeof MESSAGE_VERSION;
  type: 'CLAVIS_INJECT_TAB';
  tabId: number;
  /** The tab's URL as the popup saw it (readable under `activeTab`), to skip restricted pages early. */
  url?: string;
}

/** Background -> observer: show the toolbar for the selection that exists right now. */
export interface OpenSelectionMessage {
  v: typeof MESSAGE_VERSION;
  type: 'CLAVIS_OPEN_SELECTION';
  /** Also move keyboard focus into the toolbar (the keyboard shortcut path). */
  focus?: boolean;
  /**
   * Also press Explain for that selection (FR-018): the context menu item and the popup's "Explain
   * on this page" are an explicit request to explain, so the card opens and sends the core request
   * (or asks the one-time first-send question, which only a click in the card can answer). Sent by
   * the background only, and only the frame that holds the selection reacts.
   */
  explain?: boolean;
}

export type InjectReason = 'restricted' | 'no-access' | 'failed';
export type InjectResult = { ok: true; shown: boolean } | { ok: false; reason: InjectReason };

/** Build output paths. `*_FILE` is manifest-relative (registerContentScripts); `*_PATH` is root-relative (executeScript, getURL). */
export const OBSERVER_SCRIPT_FILE = 'content-scripts/content.js';
export const OBSERVER_SCRIPT_PATH = `/${OBSERVER_SCRIPT_FILE}` as const satisfies ScriptPublicPath;

/** Background -> top-frame observer: show a notice instead of a toolbar (handled in lib/selection/notice.ts). */
export function showNoticeMessage(reason: ShowNoticeMessage['reason']): ShowNoticeMessage {
  return { v: MESSAGE_VERSION, type: 'CLAVIS_SHOW_NOTICE', reason };
}

export function injectTabMessage(tabId: number, url?: string): InjectTabMessage {
  return {
    v: MESSAGE_VERSION,
    type: 'CLAVIS_INJECT_TAB',
    tabId,
    ...(url === undefined ? {} : { url }),
  };
}

export function openSelectionMessage(
  options: { focus?: boolean; explain?: boolean } = {},
): OpenSelectionMessage {
  return {
    v: MESSAGE_VERSION,
    type: 'CLAVIS_OPEN_SELECTION',
    ...(options.focus === true ? { focus: true } : {}),
    ...(options.explain === true ? { explain: true } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isInjectTabMessage(value: unknown): value is InjectTabMessage {
  return (
    isRecord(value) &&
    value['v'] === MESSAGE_VERSION &&
    value['type'] === 'CLAVIS_INJECT_TAB' &&
    typeof value['tabId'] === 'number' &&
    Number.isInteger(value['tabId']) &&
    (value['url'] === undefined || typeof value['url'] === 'string')
  );
}

export function isOpenSelectionMessage(value: unknown): value is OpenSelectionMessage {
  return (
    isRecord(value) &&
    value['v'] === MESSAGE_VERSION &&
    value['type'] === 'CLAVIS_OPEN_SELECTION' &&
    (value['focus'] === undefined || typeof value['focus'] === 'boolean') &&
    (value['explain'] === undefined || typeof value['explain'] === 'boolean')
  );
}
