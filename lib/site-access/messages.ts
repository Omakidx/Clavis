import type { ScriptPublicPath } from 'wxt/utils/inject-script';
import { MESSAGE_VERSION } from '../config/constants';

/**
 * Spike B internal messages between the observer, the background and the popup.
 *
 * Deliberately plain objects (no zod): the observer bundle is budgeted at 15 KB
 * gzipped. Phase 3 folds these into the single message router and
 * `lib/contracts/messages.ts`; until then the background validates them with the
 * guards below and checks the sender.
 */

/** Observer -> background: inject the UI script into the sender's own frame (option a). */
export interface InjectUiMessage {
  v: typeof MESSAGE_VERSION;
  type: 'CLAVIS_INJECT_UI';
}

/** Extension page -> background: inject observer + UI into a tab via `activeTab` (popup fallback). */
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
}

export type InjectReason = 'restricted' | 'no-access' | 'failed';
export type InjectResult = { ok: true; shown: boolean } | { ok: false; reason: InjectReason };

/** Build output paths. `*_FILE` is manifest-relative (registerContentScripts); `*_PATH` is root-relative (executeScript, getURL). */
export const OBSERVER_SCRIPT_FILE = 'content-scripts/content.js';
export const UI_SCRIPT_FILE = 'content-scripts/content-ui.js';
export const OBSERVER_SCRIPT_PATH = `/${OBSERVER_SCRIPT_FILE}` as const satisfies ScriptPublicPath;
export const UI_SCRIPT_PATH = `/${UI_SCRIPT_FILE}` as const satisfies ScriptPublicPath;

export function injectUiMessage(): InjectUiMessage {
  return { v: MESSAGE_VERSION, type: 'CLAVIS_INJECT_UI' };
}

export function injectTabMessage(tabId: number, url?: string): InjectTabMessage {
  return {
    v: MESSAGE_VERSION,
    type: 'CLAVIS_INJECT_TAB',
    tabId,
    ...(url === undefined ? {} : { url }),
  };
}

export function openSelectionMessage(focus = false): OpenSelectionMessage {
  return { v: MESSAGE_VERSION, type: 'CLAVIS_OPEN_SELECTION', ...(focus ? { focus: true } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isInjectUiMessage(value: unknown): value is InjectUiMessage {
  return isRecord(value) && value['v'] === MESSAGE_VERSION && value['type'] === 'CLAVIS_INJECT_UI';
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
    (value['focus'] === undefined || typeof value['focus'] === 'boolean')
  );
}
