import { trimCaptured, type Box, type CapturedSelection } from '../../lib/selection/capture';
import { deepActiveElement } from '../../lib/selection/eligibility';
import { markOwnUi, isOwnUiNode } from '../../lib/selection/own-ui';
import { truncateText } from '../../lib/selection/text';
import { isTrustedEvent } from '../../lib/selection/trust';
import { selectionWithin } from '../../lib/selection/contained-range';
import type {
  ActionContext,
  CardSurface,
  DismissReason,
  ListenReport,
  ToolbarActionResult,
  ToolbarHandle,
  ToolbarOptions,
} from '../../lib/selection/ui-api';
import { LIMITS } from '../../lib/config/constants';
import { t, type MessageKey } from '../../lib/i18n';
import { isInsideComposed, modalDialogOf } from './mount';
import { placeToolbar, type Placement, type Viewport } from './position';
import css from './toolbar.css?inline';
import type { ButtonName, ListenViewState, ToolbarMode, ToolbarViewProps } from './view';

/** Renders the shared toolbar tree with one UI library (Preact in production). */
export interface ViewRenderer {
  render(container: HTMLElement, props: ToolbarViewProps): void;
  unmount(container: HTMLElement): void;
}

/** How long after a pointer press inside the toolbar a selection collapse is still ignored. */
const POINTER_GRACE_MS = 300;
const CARD_TEXT_MAX_CHARS = 200;
/** Live regions announce changes, not insertions: set the text a moment after the region shows. */
const ANNOUNCE_DELAY_MS = 80;
/** Distance of a notice from the top of the viewport. */
const NOTICE_TOP = 12;

// Inline `!important` beats any page stylesheet targeting the host element.
// `display` is added separately: the host is `none` while no toolbar is shown.
const HOST_STYLE = [
  'position:fixed',
  'inset:auto',
  'top:0',
  'left:0',
  'width:0',
  'height:0',
  'margin:0',
  'padding:0',
  'border:0',
  'overflow:visible',
  'background:transparent',
  'pointer-events:none',
]
  .map((rule) => `${rule}!important`)
  .join(';');

const hostStyle = (display: 'block' | 'none'): string =>
  `display:${display}!important;${HOST_STYLE}`;

type PopoverHost = HTMLElement & { showPopover?: () => void; hidePopover?: () => void };

function applyStyles(shadow: ShadowRoot, doc: Document): void {
  // A constructable stylesheet is not subject to the page's `style-src` CSP; a
  // <style> element is. Fall back to <style> only where adoptedStyleSheets is missing.
  try {
    const sheet = new (doc.defaultView ?? window).CSSStyleSheet();
    sheet.replaceSync(css);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = doc.createElement('style');
    style.textContent = css;
    shadow.append(style);
  }
}

function idleListen(slow: boolean): ListenViewState {
  return { status: 'idle', slow, message: '', hint: '', note: '' };
}

function isThenable(value: unknown): value is PromiseLike<void> {
  return typeof (value as PromiseLike<void> | undefined)?.then === 'function';
}

/**
 * Framework-free toolbar shell: Shadow DOM host, placement, dismissal, focus and the pointer
 * rules that keep the captured selection alive. The UI library only draws `view.ts`.
 *
 * What the buttons DO is the content-side controller's business (`ToolbarActions`).
 */
export function createToolbar(
  renderer: ViewRenderer,
  options: ToolbarOptions = {},
  doc: Document = document,
): ToolbarHandle {
  const win = doc.defaultView ?? window;
  const actions = options.actions ?? {};
  let host: PopoverHost | null = null;
  let shadow: ShadowRoot | null = null;
  let panelParent: HTMLElement | null = null;
  let selection: CapturedSelection | null = null;
  let mode: ToolbarMode = 'actions';
  let notice = '';
  let card: ToolbarViewProps['card'] = null;
  let trimmed: ToolbarViewProps['trimmed'] = null;
  let busy: ToolbarViewProps['busy'] = null;
  /** Where Listen is, from what its action reported. Reset for every selection. */
  let listenView: ListenViewState = idleListen(false);
  /** The user's choice with the Slow toggle for this selection; undefined = the speed in use. */
  let slowChoice: boolean | undefined;
  let live = '';
  let previousFocus: Element | null = null;
  let visible = false;
  let pointerInside = false;
  let releaseTimer: number | undefined;
  let announceTimer: number | undefined;
  let frame = 0;
  /**
   * One slot per action, so Listen and Explain never abort each other. `id` invalidates the settle
   * callback of a run that was superseded or dismissed.
   */
  const runs: Record<'listen' | 'explain', { id: number; abort: AbortController | null }> = {
    listen: { id: 0, abort: null },
    explain: { id: 0, abort: null },
  };

  /** Drop the running action(s): the outcome is ignored and the `signal` is aborted. */
  function cancelRun(name?: 'listen' | 'explain'): void {
    for (const key of name === undefined ? (['listen', 'explain'] as const) : [name]) {
      const slot = runs[key];
      slot.id += 1;
      const abort = slot.abort;
      slot.abort = null;
      abort?.abort();
    }
  }

  const props = (): ToolbarViewProps => ({
    mode,
    kind: selection?.snapshot.kind ?? 'word',
    notice,
    card,
    trimmed,
    busy,
    listen: listenView,
    live,
    onAction: handleAction,
  });

  const context = (): ActionContext | null =>
    selection === null ? null : { snapshot: selection.snapshot, overLimit: selection.overLimit };

  function emitDismiss(reason: DismissReason): void {
    const current = context();
    if (current !== null) actions.dismiss?.({ ...current, reason });
  }

  /** Update the polite live region (after a beat, so the change is announced, not just inserted). */
  function announce(text: string): void {
    win.clearTimeout(announceTimer);
    live = '';
    announceTimer = win.setTimeout(() => {
      if (!visible) return;
      live = text;
      render();
    }, ANNOUNCE_DELAY_MS);
  }

  function handleAction(name: ButtonName, event: Event): void {
    // A page script cannot reach this closed root, but never act on a synthetic event anyway.
    if (!isTrustedEvent(event) || name === busy) return;
    if (name === 'close') {
      hide('close');
      return;
    }
    if (name === 'voice-settings') {
      actions.openVoiceSettings?.();
      return;
    }
    if (name === 'slow') {
      listenView = { ...listenView, slow: !listenView.slow };
      slowChoice = listenView.slow;
      render();
      return;
    }
    if (selection === null) return;
    if (name === 'trim') trim(selection);
    else if (name === 'listen') pressListen(selection);
    else perform('explain', selection);
  }

  /** What a Listen report means for the buttons and the live region (never guessed). */
  function applyListen(report: ListenReport): void {
    const slow = 'slow' in report && report.slow !== undefined ? report.slow : listenView.slow;
    const next = idleListen(slow);
    let spoken = '';
    if (report.status === 'starting') {
      next.status = 'starting';
      spoken = t('speechStarting');
    } else if (report.status === 'playing') {
      next.status = 'playing';
      // Keep playback announcements accessible without adding a visible label beside the audio.
      spoken = [t('speechPlaying'), report.remote ? t('speechRemoteNote') : '']
        .filter(Boolean)
        .join(' ');
    } else if (report.status === 'ended') {
      next.status = 'ended';
      if (report.message !== undefined) next.message = spoken = t(report.message);
    } else if (report.status !== 'idle') {
      next.status = report.status;
      next.message = t(report.message);
      if (report.hint !== undefined) next.hint = t(report.hint);
      spoken = [next.message, next.hint].filter(Boolean).join(' ');
    }
    listenView = next;
    if (spoken !== '') announce(spoken);
    render();
  }

  /** Listen button: Stop while playing, otherwise start (or replay) the selection. */
  function pressListen(current: CapturedSelection): void {
    if (listenView.status === 'starting' || listenView.status === 'playing') {
      // Aborting the run is what stops (or cancels the start of) the audio: the action listens to
      // its signal and sends TTS_STOP. Cancel works while starting too, so a slow start is never a trap.
      cancelRun('listen');
      applyListen({ status: 'idle' });
      announce(t('speechStopped'));
      return;
    }
    const { snapshot, overLimit } = current;
    // Another Listen press supersedes the previous utterance; Explain is not touched.
    cancelRun('listen');
    const id = runs.listen.id;
    const control = new AbortController();
    runs.listen.abort = control;
    const isCurrent = (): boolean => id === runs.listen.id && visible;
    let result: ToolbarActionResult;
    try {
      result = actions.listen?.({
        snapshot,
        overLimit,
        signal: control.signal,
        listen: {
          slow: slowChoice,
          report: (report) => {
            if (isCurrent()) applyListen(report);
          },
        },
      });
    } catch {
      result = Promise.reject(new Error('action failed'));
    }
    if (!isThenable(result)) return;
    if (listenView.status === 'idle') applyListen({ status: 'starting' });
    result.then(
      () => {
        if (isCurrent() && listenView.status === 'starting') applyListen({ status: 'idle' });
      },
      (error: unknown) => {
        if (!isCurrent()) return;
        const key = (error as { messageKey?: unknown } | null)?.messageKey;
        applyListen({
          status: 'failed',
          message: (typeof key === 'string' ? key : 'toolbarActionFailed') as MessageKey,
        });
      },
    );
  }

  /** "Use the first 2,000 characters": local only, the new snapshot is shown before anything is sent. */
  function trim(current: CapturedSelection): void {
    const next = trimCaptured(current);
    const hadFocus = (shadow?.activeElement ?? null) !== null;
    selection = next;
    mode = 'actions';
    card = null;
    busy = null;
    // A different text: playback of the old one stops and its state is gone.
    cancelRun();
    listenView = idleListen(listenView.slow);
    const length = next.snapshot.text.length;
    trimmed = { text: next.snapshot.text, length };
    render();
    if (hadFocus) focusButton();
    announce(t('toolbarTrimmed', length.toLocaleString()));
    actions.trim?.({ snapshot: next.snapshot, overLimit: false });
  }

  /** The container the loaded explanation card draws in, while the toolbar shows one. */
  function slotElement(): HTMLElement | null {
    return panelParent?.querySelector<HTMLElement>('[data-clavis="card-slot"]') ?? null;
  }

  /** What an action may use to draw its own card (see `CardSurface`); valid for run `id` only. */
  function createSurface(id: number, text: string, keyboard: boolean): CardSurface {
    const current = (): boolean => id === runs.explain.id && visible;
    return {
      keyboard,
      speakerIcon() {
        return (
          (panelParent
            ?.querySelector('[data-action="listen"] [data-icon="speak"]')
            ?.cloneNode(true) as Element | null) ?? null
        );
      },
      speak(text, lang, report) {
        if (
          !current() ||
          selection === null ||
          actions.listen === undefined ||
          text.length > LIMITS.maxSelectionChars
        ) {
          report({ status: 'failed', message: 'speechInvalidRequest' });
          return () => undefined;
        }
        cancelRun('listen');
        const control = new AbortController();
        runs.listen.abort = control;
        const listenId = runs.listen.id;
        control.signal.addEventListener('abort', () => report({ status: 'idle' }), { once: true });
        const stop = (): void => {
          if (runs.listen.abort !== control) return;
          cancelRun('listen');
          applyListen({ status: 'idle' });
        };
        try {
          const outcome = actions.listen({
            snapshot: {
              selectionId: selection.snapshot.selectionId,
              source: selection.snapshot.source,
              kind: 'word',
              text,
            },
            overLimit: false,
            signal: control.signal,
            listen: {
              slow: undefined,
              lang,
              report(value) {
                if (!current() || control.signal.aborted || listenId !== runs.listen.id) return;
                applyListen(value);
                report(value);
              },
            },
          });
          Promise.resolve(outcome).catch(() => {
            if (current() && !control.signal.aborted) {
              const failure: ListenReport = { status: 'failed', message: 'toolbarActionFailed' };
              applyListen(failure);
              report(failure);
            }
          });
        } catch {
          report({ status: 'failed', message: 'toolbarActionFailed' });
        }
        return stop;
      },
      open() {
        if (!current() || panelParent === null) return null;
        if (card?.slot !== true) {
          card = { action: 'explain', text, note: '', slot: true };
          render();
        }
        return slotElement();
      },
      reposition() {
        if (current()) schedulePosition();
      },
      close() {
        if (!current()) return;
        const hadFocus = (shadow?.activeElement ?? null) !== null;
        cancelRun('explain');
        busy = null;
        card = null;
        render();
        // The focused control is about to disappear: keep keyboard users on the toolbar.
        if (hadFocus) {
          buttons()
            .find((button) => button.getAttribute('data-action') === 'explain')
            ?.focus();
        }
      },
    };
  }

  function perform(name: 'explain', current: CapturedSelection): void {
    // Uses the snapshot captured at selection end, not the live (maybe collapsed) selection.
    const { snapshot, overLimit } = current;
    // Pressing Explain again supersedes the previous explain run; Listen keeps playing.
    cancelRun('explain');
    // A Listen problem note gives way to the card (it would push the card's footer off screen).
    listenView = { ...listenView, message: '', hint: '' };
    const id = runs.explain.id;
    const control = new AbortController();
    runs.explain.abort = control;
    const text = truncateText(snapshot.text, CARD_TEXT_MAX_CHARS);
    const keyboard = (shadow?.activeElement ?? null) !== null;
    // The state line stays until an action that draws its own card replaces it (`surface.open()`).
    card = { action: name, text, note: t('toolbarWorking') };
    let result: ToolbarActionResult;
    try {
      result = actions[name]?.({
        snapshot,
        overLimit,
        signal: control.signal,
        surface: createSurface(id, text, keyboard),
      });
    } catch {
      result = Promise.reject(new Error('action failed'));
    }
    if (!isThenable(result)) {
      busy = null;
      if (card?.slot !== true) card = { action: name, text, note: t('toolbarCardPlaceholder') };
      render();
      return;
    }
    busy = name;
    render();
    announce(t('toolbarWorking'));
    const settle = (note: string, spoken: string): void => {
      if (id !== runs.explain.id || !visible) return;
      busy = null;
      // A card the action drew itself keeps its own states; only the state line is replaced.
      if (card?.slot !== true) card = { action: name, text, note };
      if (spoken !== '') announce(spoken);
      render();
    };
    result.then(
      () => settle(t('toolbarCardPlaceholder'), ''),
      (error: unknown) => {
        // A specific message when the action supplied one (`actionError`), else the generic line.
        const key = (error as { messageKey?: unknown } | null)?.messageKey;
        const message =
          (typeof key === 'string' ? t(key as MessageKey) : '') || t('toolbarActionFailed');
        settle(message, message);
      },
    );
  }

  function render(): void {
    if (panelParent === null || !visible) return;
    renderer.render(panelParent, props());
    const el = panel();
    if (el !== null) el.hidden = false;
    position();
  }

  function panel(): HTMLElement | null {
    return panelParent?.firstElementChild as HTMLElement | null;
  }

  /** The area the toolbar may use: the pinch-zoomed visual viewport, else the layout viewport. */
  function viewport(): Viewport {
    const visual = win.visualViewport;
    if (visual !== null && visual !== undefined && visual.scale !== 1) {
      return {
        left: visual.offsetLeft,
        top: visual.offsetTop,
        width: visual.width,
        height: visual.height,
      };
    }
    return { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  }

  /**
   * True when a fixed or sticky page element (a header, a cookie banner) that does not contain
   * the selection is on top of `box`: text behind it cannot be seen, and the toolbar should not
   * sit on it.
   */
  function isCovered(box: Box): boolean {
    const anchor = selection?.range.commonAncestorContainer ?? null;
    const hit = doc.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    if (hit === null || isOwnUiNode(hit)) return false;
    for (let el: Element | null = hit; el !== null;) {
      const { position } = win.getComputedStyle(el);
      if (position === 'fixed' || position === 'sticky') return !isInsideComposed(anchor, el);
      el = el.parentElement ?? (el.getRootNode() as Partial<ShadowRoot>).host ?? null;
    }
    return false;
  }

  function place(size: { width: number; height: number }): Placement | null {
    const view = viewport();
    if (selection === null) {
      // A notice has no selection to sit next to: top centre of the visible area.
      return {
        left: (view.left ?? 0) + (view.width - size.width) / 2,
        top: (view.top ?? 0) + NOTICE_TOP,
        side: 'overlay',
      };
    }
    const rects = selection.getRects();
    if (rects === null) return null;
    return placeToolbar({
      rects,
      size,
      viewport: view,
      dir: selection.dir,
      ...(selection.vertical === undefined ? {} : { vertical: selection.vertical }),
      isCovered,
    });
  }

  function position(): void {
    const el = panel();
    if (el === null) return;
    const box = el.getBoundingClientRect();
    // A zoomed or scaled <html> scales the host's pixels: convert viewport pixels back to its own.
    // (`offsetWidth` is rounded to a whole pixel, which would skew the scale by up to a percent.)
    const layoutWidth = Number.parseFloat(win.getComputedStyle(el).width) || el.offsetWidth;
    const scale = box.width > 0 && layoutWidth > 0 ? box.width / layoutWidth : 1;
    const placement = place({
      width: box.width || el.offsetWidth,
      height: box.height || el.offsetHeight,
    });
    if (placement === null) {
      el.style.visibility = 'hidden';
      return;
    }
    const ratio = win.devicePixelRatio || 1;
    // Whole DEVICE pixels: a host pixel is `ratio * scale` device pixels under a zoomed <html>.
    const device = ratio * scale;
    const snap = (value: number): string => `${Math.round((value / scale) * device) / device}px`;
    el.style.left = snap(placement.left);
    el.style.top = snap(placement.top);
    el.style.visibility = '';
  }

  function schedulePosition(): void {
    if (frame !== 0) return;
    frame = win.requestAnimationFrame(() => {
      frame = 0;
      if (visible) position();
    });
  }

  function ensureHost(): HTMLElement {
    if (host !== null && panelParent !== null) return host;
    // A plain <div>: no tag name for page CSS or scripts to single out. A custom-element tag
    // would also let a page pre-define it and read even a closed root via ElementInternals.
    const el: PopoverHost = doc.createElement('div');
    markOwnUi(el);
    el.setAttribute('popover', 'manual');
    el.setAttribute('style', hostStyle('none'));
    // Closed, and the root lives only in this closure: `host.shadowRoot` is null for pages.
    shadow = el.attachShadow({ mode: 'closed' });
    applyStyles(shadow, doc);
    const parent = doc.createElement('div');
    panelParent = parent;
    shadow.append(parent);

    // Listeners sit INSIDE the shadow tree: a listener on the host would see every event
    // retargeted to the host and could not tell a button press from anything else.
    parent.addEventListener('pointerdown', (event) => {
      if (!isTrustedEvent(event)) return;
      pointerInside = true;
      win.clearTimeout(releaseTimer);
    });
    const release = (event: Event): void => {
      if (!isTrustedEvent(event)) return;
      releaseTimer = win.setTimeout(() => {
        pointerInside = false;
      }, POINTER_GRACE_MS);
    };
    parent.addEventListener('pointerup', release);
    parent.addEventListener('pointercancel', release);
    // Pressing a button must not move focus or collapse the page selection.
    parent.addEventListener('mousedown', (event) => {
      const origin = event.target;
      if (origin instanceof win.Element && origin.closest('button') !== null)
        event.preventDefault();
    });
    parent.addEventListener('keydown', onToolbarKeyDown);
    host = el;
    return el;
  }

  /** The toolbar's own buttons (arrow-key group), not the controls of a card inside it. */
  function buttons(): HTMLButtonElement[] {
    return Array.from(panelParent?.querySelectorAll('button') ?? []).filter(
      (button) => button.closest('[data-clavis="card-slot"]') === null,
    );
  }

  function focusButton(): void {
    buttons()[0]?.focus();
  }

  /** Give keyboard focus back to where it was before the toolbar took it (or just drop it). */
  function restoreFocus(): void {
    const target = previousFocus;
    previousFocus = null;
    if (target !== null && target.isConnected && target !== doc.body) {
      (target as HTMLElement).focus({ preventScroll: true });
    } else {
      (shadow?.activeElement as HTMLElement | null)?.blur();
    }
  }

  function onToolbarKeyDown(event: KeyboardEvent): void {
    if (!isTrustedEvent(event)) return;
    // The loaded card handles its own Tab and arrow keys (a tab list, several controls).
    if ((event.target as Element | null)?.closest?.('[data-clavis="card-slot"]')) return;
    // Tab leaves the toolbar from where the user was, not from the end of the document.
    if (event.key === 'Tab') {
      restoreFocus();
      return;
    }
    const list = buttons();
    const index = list.findIndex((button) => button === shadow?.activeElement);
    if (index === -1) return;
    const rtl = selection?.dir === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    let next = -1;
    if (event.key === forward) next = (index + 1) % list.length;
    else if (event.key === backward) next = (index - 1 + list.length) % list.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = list.length - 1;
    if (next === -1) return;
    event.preventDefault();
    list[next]?.focus();
  }

  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || !isTrustedEvent(event)) return;
    // Inside a modal dialog Escape would also close the dialog; the first press only closes us.
    if (host?.parentNode !== doc.documentElement) event.preventDefault();
    hide('escape');
  };
  const onDocumentPointerDown = (event: Event): void => {
    if (!isTrustedEvent(event)) return;
    if (host !== null && event.composedPath().includes(host)) return;
    hide('outside');
  };
  const onViewportChange = (): void => schedulePosition();

  function listen(): void {
    doc.addEventListener('keydown', onDocumentKeyDown, true);
    doc.addEventListener('pointerdown', onDocumentPointerDown, true);
    win.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    win.addEventListener('resize', onViewportChange, { passive: true });
    win.visualViewport?.addEventListener('resize', onViewportChange);
    win.visualViewport?.addEventListener('scroll', onViewportChange);
  }

  function unlisten(): void {
    doc.removeEventListener('keydown', onDocumentKeyDown, true);
    doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
    win.removeEventListener('scroll', onViewportChange, { capture: true });
    win.removeEventListener('resize', onViewportChange);
    win.visualViewport?.removeEventListener('resize', onViewportChange);
    win.visualViewport?.removeEventListener('scroll', onViewportChange);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
  }

  /** Mount the host (inside an open modal dialog when the selection is in one) and draw. */
  function open(): void {
    const el = ensureHost();
    const parent =
      modalDialogOf(selection?.range.commonAncestorContainer ?? null) ?? doc.documentElement;
    const moved = el.parentNode !== parent;
    // Removing a shown popover closes it, so a moved host has to be shown again.
    if (moved) parent.append(el);
    if (!visible || moved) {
      el.setAttribute('style', hostStyle('block'));
      try {
        // Top layer: above any page z-index, no z-index war (docs/tech-stack.md section 6).
        (el as PopoverHost).showPopover?.();
      } catch {
        el.setAttribute('style', `${hostStyle('block')};z-index:2147483000!important`);
      }
    }
    if (!visible) {
      visible = true;
      listen();
    }
    if (panelParent !== null) {
      panelParent.dir =
        selection?.dir ??
        (win.getComputedStyle(doc.documentElement).direction === 'rtl' ? 'rtl' : 'ltr');
    }
    render();
  }

  function reset(): void {
    card = null;
    trimmed = null;
    busy = null;
    slowChoice = undefined;
    listenView = idleListen(false);
    live = '';
    notice = '';
    cancelRun();
    win.clearTimeout(announceTimer);
  }

  function show(next: CapturedSelection): void {
    if (visible && selection !== next) emitDismiss('replaced');
    selection = next;
    reset();
    mode = next.overLimit ? 'too-long' : 'actions';
    open();
    if (next.overLimit) {
      announce(t('toolbarTooLongLive', LIMITS.maxSelectionChars.toLocaleString()));
    }
  }

  function showNotice(message: string): void {
    if (visible) emitDismiss('replaced');
    selection = null;
    reset();
    mode = 'notice';
    notice = message;
    open();
    announce(message);
  }

  function hide(reason: DismissReason = 'cleared'): void {
    if (!visible) return;
    emitDismiss(reason);
    visible = false;
    unlisten();
    // Keyboard focus must not fall into the void when the focused button disappears.
    if ((shadow?.activeElement ?? null) !== null) restoreFocus();
    previousFocus = null;
    selection = null;
    reset();
    pointerInside = false;
    // Keep the rendered tree (and the UI library root) for the next, faster, selection.
    const hidden = panel();
    if (hidden !== null) hidden.hidden = true;
    try {
      host?.hidePopover?.();
    } catch {
      // Not shown as a popover (fallback path); nothing to hide.
    }
    host?.setAttribute('style', hostStyle('none'));
  }

  return {
    show,
    showNotice,
    hide,
    isInteracting() {
      if (!visible) return false;
      if (pointerInside || (shadow?.activeElement ?? null) !== null) return true;
      // Result text stays selected after pointer grace ends. Keep that selection inside the
      // card rather than letting the page observer clear the whole lookup during drill-down.
      const slot = slotElement();
      return slot !== null && selectionWithin(slot) !== null;
    },
    explain() {
      // Not for a selection that is over the limit: that one offers "use the first 2,000" first.
      if (selection !== null && mode === 'actions') perform('explain', selection);
    },
    focus() {
      const active = deepActiveElement(doc);
      if (active !== null && active !== doc.body && !isOwnUiNode(active)) previousFocus = active;
      focusButton();
    },
    destroy() {
      hide();
      // Nothing may fire after the toolbar is gone (an orphaned content script cleans up here).
      win.clearTimeout(releaseTimer);
      win.clearTimeout(announceTimer);
      if (frame !== 0) win.cancelAnimationFrame(frame);
      frame = 0;
      cancelRun();
      if (panelParent !== null) renderer.unmount(panelParent);
      host?.remove();
      host = null;
      shadow = null;
      panelParent = null;
    },
  };
}
