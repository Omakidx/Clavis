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
  /**
   * Present for `listen` only: what the toolbar needs to know about the playback to show it
   * truthfully (Phase 6). Listen and Explain have separate run slots, so pressing one never aborts
   * the other; `signal` of a Listen run is aborted by Stop, by another Listen press, by a new
   * selection and by dismissal, and the action must then stop the audio.
   */
  listen?: ListenSurface;
  /**
   * Lets the action draw its own card inside the toolbar (Phase 5 Explain card). Absent for
   * hosts that only show the toolbar's state line.
   */
  surface?: CardSurface;
}

/**
 * What Listen reports back. The toolbar shows "playing" only after `playing`, which the action may
 * report only once audio has really started (never on a guess).
 */
export type ListenReport =
  /** Nothing is playing (a run that ended without anything to say). */
  | { status: 'idle' }
  /** Requested, no audio yet (spinner). `slow` is the effective speed once known. */
  | { status: 'starting'; slow?: boolean }
  /** Audio is playing. `remote`: the voice sends the text to an online service. */
  | { status: 'playing'; slow: boolean; remote: boolean }
  /** Playback finished or was cut short; `message` is set when it ended by error. Replay is offered. */
  | { status: 'ended'; message?: MessageKey }
  /** Could not start (not for lack of a voice). */
  | { status: 'failed'; message: MessageKey; hint?: MessageKey }
  /** No voice on this device. The toolbar adds a "Voice settings" action. */
  | { status: 'unavailable'; message: MessageKey; hint?: MessageKey };

/** What a Listen run receives to report through (see `RunContext.listen`). */
export interface ListenSurface {
  /** The speed the user chose with the toolbar's Slow toggle for this selection; undefined = preference. */
  slow: boolean | undefined;
  /** Known output language, which takes priority over the general voice-language preference. */
  lang?: string | undefined;
  report(report: ListenReport): void;
}

/**
 * What the toolbar lends an action that draws its own card (the separately loaded explanation
 * card, D-08). The toolbar owns the closed shadow root, placement, focus and dismissal; the card
 * only draws inside `open()` and reports size changes. It never receives the root itself.
 */
export interface CardSurface {
  /** Read generated output with the existing Listen action and saved voice; return Stop. */
  speak?(
    text: string,
    lang: string | undefined,
    report: (report: ListenReport) => void,
  ): () => void;
  /** Clone the existing toolbar speaker artwork without bundling a second copy in the card. */
  speakerIcon?(): Element | null;
  /** The action was started from the keyboard (a toolbar button had focus), so focus may move. */
  keyboard: boolean;
  /**
   * The empty element inside the toolbar's closed root the card renders into. The first call
   * replaces the toolbar's own state line with it. Null once this run is no longer current.
   */
  open(): HTMLElement | null;
  /** Re-run placement after the card changed size. */
  reposition(): void;
  /**
   * Remove the card, abort the run (its `signal`) and put keyboard focus back on the button that
   * opened it. The toolbar itself stays.
   */
  close(): void;
}

/**
 * The separately loaded explanation card (components/explanation). `entrypoints/explain-card.ts`
 * registers it on `EXPLAIN_CARD_GLOBAL` in the frame's isolated world; the page's main world has no
 * access to that world, so a page can neither reach it nor replace it.
 */
export interface ExplainCardApi {
  /**
   * Show the card for `context` in its `surface` and start the core request (unless this
   * selection already has one). Resolves once the card is on screen; request failures are shown
   * IN the card, not thrown. Rejects only when there is no surface to draw on.
   */
  present(context: RunContext): Promise<void>;
  /**
   * The toolbar closed or the selection was replaced: cancel pending requests and drop the cache of
   * `selectionId` (of everything when omitted, for example after a trim).
   */
  dismiss(selectionId?: string): void;
  /** Remove everything (extension update, a newer injection, observer stop). */
  destroy(): void;
}

/** Where the loaded card registers itself (isolated world only). */
export const EXPLAIN_CARD_GLOBAL = Symbol.for('clavis.explain-card');

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
  /**
   * Listen pressed (Phase 6: TTS_SPEAK with `snapshot.text` only). Reports its state through
   * `context.listen`; a returned promise is also honoured (pending = starting, rejected = failed).
   */
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
  /** "Voice settings" pressed in the no-voice message: open Settings at the Voice section. */
  openVoiceSettings?(): void;
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
  /** True while pointer/focus interaction or a selected popup result keeps the toolbar active. */
  isInteracting(): boolean;
  /** Move keyboard focus into the toolbar (the Alt+Shift+E path); Escape or Tab gives it back. */
  focus(): void;
  /** Start Explain for the selection shown, as if its button was pressed (context menu, popup button). */
  explain?(): void;
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
