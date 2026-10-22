import type { SelectionSnapshot } from '../contracts/selection';
import type { MessageKey } from '../i18n';
import type { CapturedSelection } from './capture';

/**
 * The content-side action interface (Phase 4). The toolbar reports what the user chose; the
 * controller that mounts it decides what that means. Phase 5 implements `explain` (AI_EXPLAIN),
 * Phase 6 implements `listen` (TTS_SPEAK); both are optional members of `ToolbarActions`, so the
 * toolbar needs no change when they land. Phase 4 only ships `createLocalActions`
 * (lib/selection/local-actions.ts): local visual states, no network, no background traffic.
 *
 * Every call carries the snapshot CAPTURED at selection end (never re-read from the live
 * Selection, which a button press may collapse) and only ever runs from a trusted user event.
 */

/** What the user did in the toolbar. */
export type ToolbarActionName = 'listen' | 'explain' | 'trim' | 'dismiss';

/** The selection an action applies to. */
export interface ActionContext {
  /** Ready to send: at most `LIMITS.maxSelectionChars`, normalized, with bounded context. */
  snapshot: SelectionSnapshot;
  /**
   * The selection was longer than the limit. `snapshot` then holds only a prefix, and the toolbar
   * offers `trim` instead of `listen`/`explain`, so those two never see `overLimit: true`.
   */
  overLimit: boolean;
}

/**
 * What `listen` and `explain` receive. `signal` is aborted when the work is no longer wanted:
 * another button was pressed (superseded), a different selection replaced this one, or the
 * toolbar was dismissed. Phase 5/6 pass it to the request (and cancel the speech) and drop any
 * late result; the toolbar already ignores the outcome of an aborted run.
 */
export interface RunContext extends ActionContext {
  signal: AbortSignal;
}

/**
 * Reject with this to show a specific message in the toolbar instead of the generic "That didn't
 * work" line. `messageKey` is a key of the English catalog (public/_locales/en/messages.json);
 * anything else a promise rejects with gets the generic line.
 */
export function actionError(messageKey: MessageKey): Error & { messageKey: MessageKey } {
  return Object.assign(new Error(messageKey), { messageKey });
}

export type DismissReason =
  /** Escape key. */
  | 'escape'
  /** A pointer press outside the toolbar. */
  | 'outside'
  /** The selection was removed or stopped qualifying. */
  | 'cleared'
  /** A different selection replaced this one. */
  | 'replaced'
  /** The close button of a notice. */
  | 'close';

export interface DismissContext extends ActionContext {
  reason: DismissReason;
}

/**
 * Return a promise to keep the button in its working state until it settles: resolve to reset it,
 * reject to show the toolbar's error state (the user can press the button again; reject with
 * `actionError(key)` for a specific message). Return nothing for an action that has no visible
 * progress. The outcome of a run whose `signal` was aborted is ignored.
 */
export type ToolbarActionResult = void | Promise<void>;

/** Implemented by the content-side controller; every member is optional. */
export interface ToolbarActions {
  /** Listen pressed (Phase 6: send TTS_SPEAK with `snapshot.text`). */
  listen?(context: RunContext): ToolbarActionResult;
  /** Explain pressed (Phase 5: send AI_EXPLAIN with `snapshot`). The only step that may send text. */
  explain?(context: RunContext): ToolbarActionResult;
  /**
   * "Use the first 2,000 characters" pressed. `snapshot` is the NEW, trimmed snapshot (new
   * `selectionId`, no `contextAfter`). Purely local: nothing has been or is sent by this step.
   */
  trim?(context: ActionContext): void;
  /** The toolbar closed: cancel pending work for `snapshot.selectionId` (stale-response guard). */
  dismiss?(context: DismissContext): void;
}

export interface ToolbarOptions {
  actions?: ToolbarActions;
}

export interface ToolbarHandle {
  show(selection: CapturedSelection): void;
  /**
   * Show a message that is not about a selection (for example "Clavis cannot read this frame"),
   * at the top of the viewport, with a close button.
   */
  showNotice(message: string): void;
  hide(reason?: DismissReason): void;
  /** True while a pointer press or keyboard focus is inside the toolbar (selection may collapse). */
  isInteracting(): boolean;
  /** Move keyboard focus into the toolbar (the Alt+Shift+E path); Escape or Tab gives it back. */
  focus(): void;
  destroy(): void;
}

/** Produces the toolbar, loading UI code first if it is not on the page yet. */
export type ToolbarLoader = (options: ToolbarOptions) => Promise<ToolbarHandle>;

/** What the frame's single observer exposes to a newer injection that replaces it. */
export interface SelectionControllerLike {
  stop(): void;
}

/** The frame's current observer: a registered and an injected copy never both run. */
export const OBSERVER_GLOBAL = Symbol.for('clavis.observer');
