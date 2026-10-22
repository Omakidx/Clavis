import type { CapturedSelection } from '../../lib/selection/capture';
import { markOwnUi } from '../../lib/selection/own-ui';
import { isTrustedEvent } from '../../lib/selection/trust';
import type { ToolbarHandle, ToolbarOptions } from '../../lib/selection/ui-api';
import { placeToolbar } from './position';
import css from './toolbar.css?inline';
import type { ToolbarActionName, ToolbarViewProps } from './view';

/** Renders the shared toolbar tree with one UI library (React or Preact). */
export interface ViewRenderer {
  render(container: HTMLElement, props: ToolbarViewProps): void;
  unmount(container: HTMLElement): void;
}

/** How long after a pointer press inside the toolbar a selection collapse is still ignored. */
const POINTER_GRACE_MS = 300;
const CARD_TEXT_MAX_CHARS = 200;

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

/**
 * Framework-free toolbar shell: Shadow DOM host, placement, dismissal, focus and
 * the pointer rules that keep the captured selection alive. The two UI options
 * only differ in the `renderer` they pass in.
 */
export function createToolbar(
  renderer: ViewRenderer,
  options: ToolbarOptions = {},
  doc: Document = document,
): ToolbarHandle {
  const win = doc.defaultView ?? window;
  let host: PopoverHost | null = null;
  let shadow: ShadowRoot | null = null;
  let panelParent: HTMLElement | null = null;
  let selection: CapturedSelection | null = null;
  let card: ToolbarViewProps['card'] = null;
  let visible = false;
  let pointerInside = false;
  let releaseTimer: number | undefined;
  let frame = 0;

  const props = (current: CapturedSelection): ToolbarViewProps => ({
    kind: current.snapshot.kind,
    overLimit: current.overLimit,
    card,
    onAction: handleAction,
  });

  function handleAction(action: ToolbarActionName, event: Event): void {
    // A page script cannot reach this closed root, but never act on a synthetic event anyway.
    if (selection === null || !isTrustedEvent(event)) return;
    // Uses the snapshot captured at selection end, not the live (maybe collapsed) selection.
    const { snapshot, overLimit } = selection;
    card = { action, text: snapshot.text.slice(0, CARD_TEXT_MAX_CHARS) };
    render();
    options.onAction?.({ action, snapshot, overLimit });
  }

  function render(): void {
    if (panelParent === null || selection === null) return;
    renderer.render(panelParent, props(selection));
    position();
  }

  function panel(): HTMLElement | null {
    return panelParent?.firstElementChild as HTMLElement | null;
  }

  function position(): void {
    const el = panel();
    if (el === null || selection === null) return;
    const rects = selection.getRects();
    const placement =
      rects === null
        ? null
        : placeToolbar({
            rects,
            size: { width: el.offsetWidth, height: el.offsetHeight },
            viewport: {
              width: doc.documentElement.clientWidth,
              height: doc.documentElement.clientHeight,
            },
            dir: selection.dir,
          });
    if (placement === null) {
      el.style.visibility = 'hidden';
      return;
    }
    el.style.left = `${Math.round(placement.left)}px`;
    el.style.top = `${Math.round(placement.top)}px`;
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
      if (releaseTimer !== undefined) win.clearTimeout(releaseTimer);
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

  function buttons(): HTMLButtonElement[] {
    return Array.from(panelParent?.querySelectorAll('.toolbar button') ?? []);
  }

  function onToolbarKeyDown(event: KeyboardEvent): void {
    if (!isTrustedEvent(event)) return;
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
    if (event.key === 'Escape' && isTrustedEvent(event)) hide();
  };
  const onDocumentPointerDown = (event: Event): void => {
    if (!isTrustedEvent(event)) return;
    if (host !== null && event.composedPath().includes(host)) return;
    hide();
  };
  const onViewportChange = (): void => schedulePosition();

  function listen(): void {
    doc.addEventListener('keydown', onDocumentKeyDown, true);
    doc.addEventListener('pointerdown', onDocumentPointerDown, true);
    win.addEventListener('scroll', onViewportChange, { capture: true, passive: true });
    win.addEventListener('resize', onViewportChange, { passive: true });
  }

  function unlisten(): void {
    doc.removeEventListener('keydown', onDocumentKeyDown, true);
    doc.removeEventListener('pointerdown', onDocumentPointerDown, true);
    win.removeEventListener('scroll', onViewportChange, { capture: true });
    win.removeEventListener('resize', onViewportChange);
    if (frame !== 0) win.cancelAnimationFrame(frame);
    frame = 0;
  }

  function show(next: CapturedSelection): void {
    selection = next;
    card = null;
    const el = ensureHost();
    if (!el.isConnected) doc.documentElement.append(el);
    if (!visible) {
      visible = true;
      listen();
      el.setAttribute('style', hostStyle('block'));
      try {
        // Top layer: above any page z-index, no z-index war (docs/tech-stack.md section 6).
        host?.showPopover?.();
      } catch {
        host?.setAttribute('style', `${hostStyle('block')};z-index:2147483000!important`);
      }
    }
    if (panelParent !== null) panelParent.dir = next.dir;
    render();
    const shown = panel();
    if (shown !== null) shown.hidden = false;
    position();
  }

  function hide(): void {
    if (!visible) return;
    visible = false;
    unlisten();
    selection = null;
    card = null;
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
    hide,
    isInteracting: () => visible && (pointerInside || (shadow?.activeElement ?? null) !== null),
    focus() {
      buttons()[0]?.focus();
    },
    destroy() {
      hide();
      if (panelParent !== null) renderer.unmount(panelParent);
      host?.remove();
      host = null;
      shadow = null;
      panelParent = null;
    },
  };
}
