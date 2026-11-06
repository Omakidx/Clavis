import { FEATURES, LIMITS } from '../../lib/config/constants';
import type { SelectionSnapshot } from '../../lib/contracts/selection';
import { classifySelection } from '../../lib/selection/classify';
import type { ExplainCardApi, RunContext } from '../../lib/selection/ui-api';
import { newSelectionId } from '../../lib/selection/ids';
import { normalizeText } from '../../lib/selection/text';
import { createBackend, type ExplainBackend } from './backend';
import css from './card.css?inline';
import { copyPlainText } from './copy';
import { mountCard, type CardHost, type CardNavigation } from './ExplanationCard';
import { ExplainSession, type SessionOptions } from './session';

export interface CardDeps {
  backend: ExplainBackend;
  newId(): string;
  now(): number;
  copy(doc: Document, text: string): Promise<boolean>;
  requestTimeoutMs?: number | undefined;
  features: SessionOptions['features'];
}

/**
 * Marks a shadow root that already has the card's stylesheet. A property keyed by a symbol on the
 * root object itself, not a module-level WeakSet: the card script can run more than once in the same
 * isolated world (the background re-injects it on every LOAD_EXPLAIN_CARD), and each run has its own
 * module state but sees the same root. Pages cannot reach the root or the isolated world.
 */
const STYLED = Symbol.for('clavis.card-styled');

/** Add the card's stylesheet to the toolbar's (closed) shadow root, once per root. */
function ensureStyles(slot: HTMLElement): void {
  const root = slot.getRootNode();
  const marked = root as unknown as Record<symbol, true | undefined>;
  if (marked[STYLED] === true) return;
  marked[STYLED] = true;
  const doc = slot.ownerDocument;
  try {
    // A constructable stylesheet is not subject to the page's `style-src` CSP (a <style> is).
    const sheet = new (doc.defaultView ?? window).CSSStyleSheet();
    sheet.replaceSync(css);
    (root as ShadowRoot).adoptedStyleSheets.push(sheet);
  } catch {
    const style = doc.createElement('style');
    style.textContent = css;
    slot.before(style);
  }
}

/** Space kept free around the card, and the least height worth giving it (its header, tabs and footer). */
const FIT_MARGIN = 8;
const FIT_MIN = 160;

/**
 * Keep the whole card, footer included, inside the visible window (or the frame it is drawn in):
 * whatever else the toolbar shows around the slot (its buttons, a Listen note) is subtracted from
 * the window's height and the rest is the card's own limit, so a long answer scrolls INSIDE the
 * card while Copy and Open in side panel stay on screen. Set through CSSOM, which a page's CSP
 * does not block. It reads sizes that do not depend on the card's own height, so it settles at once.
 */
function fitSlot(slot: HTMLElement): void {
  const win = slot.ownerDocument.defaultView;
  const panel = slot.parentElement;
  if (win === null || panel === null) return;
  const others = panel.getBoundingClientRect().height - slot.getBoundingClientRect().height;
  const room = Math.max(FIT_MIN, Math.floor(win.innerHeight - others - 2 * FIT_MARGIN));
  slot.style.maxHeight = `min(34rem, ${room}px)`;
}

/**
 * The explanation card (D-08): loaded separately from the always-on observer, it draws inside the
 * toolbar's closed shadow root through the `CardSurface` the toolbar lends (lib/selection/ui-api.ts).
 *
 * Each root selection owns a stack of `ExplainSession` frames. Only its active frame is attached;
 * ancestors keep their cached results while a user looks up words within generated text. Pressing
 * Explain again on the same root selection re-shows the active frame without a duplicate request.
 */
export function createExplainCard(overrides: Partial<CardDeps> = {}): ExplainCardApi {
  const deps: CardDeps = {
    backend: createBackend(),
    newId: newSelectionId,
    now: Date.now,
    copy: copyPlainText,
    features: FEATURES,
    ...overrides,
  };
  let rootSelectionId: string | null = null;
  let pendingRootSelectionId: string | null = null;
  let frames: ExplainSession[] = [];
  let targetLanguage: string | undefined;
  /** Removes the card from the surface it is showing in. */
  let unmount: (() => void) | null = null;
  /** Resize belongs to a surface run, while view removal also happens between child frames. */
  let cleanupRun: (() => void) | null = null;

  function removeView(): void {
    unmount?.();
    unmount = null;
  }

  function drop(): void {
    clearTimeout(pendingDetach);
    pendingDetach = undefined;
    removeView();
    cleanupRun?.();
    cleanupRun = null;
    for (const frame of frames) frame.destroy();
    frames = [];
    rootSelectionId = null;
    pendingRootSelectionId = null;
    targetLanguage = undefined;
  }

  /**
   * Taking the card down (an abort) cancels the request in flight one tick later, so that pressing
   * Explain again on the SAME selection, which aborts the old run and immediately presents a new
   * one, keeps the request that is already running instead of cancelling it and asking (and maybe
   * being billed) twice.
   */
  let pendingDetach: ReturnType<typeof setTimeout> | undefined;

  /** Which `present` call owns the card now; an older run's late abort must not remove a newer card. */
  let run = 0;

  return {
    async present(context: RunContext): Promise<void> {
      const { surface, snapshot, signal } = context;
      if (surface === undefined) throw new Error('The card needs a toolbar surface');
      if (signal.aborted) return;
      const mine = (run += 1);
      cleanupRun?.();
      cleanupRun = null;
      clearTimeout(pendingDetach);
      pendingDetach = undefined;

      if (rootSelectionId !== snapshot.selectionId) {
        drop();
        pendingRootSelectionId = snapshot.selectionId;
        // Only the Translate tab needs it, and that tab is behind a feature flag.
        const language = deps.features?.translateTab
          ? await deps.backend.translationLanguage()
          : undefined;
        // The user may have moved on while the language was looked up.
        if (signal.aborted || mine !== run) {
          if (mine === run) pendingRootSelectionId = null;
          return;
        }
        targetLanguage = language;
        rootSelectionId = snapshot.selectionId;
        pendingRootSelectionId = null;
        frames = [
          new ExplainSession({
            snapshot,
            backend: deps.backend,
            newId: deps.newId,
            now: deps.now,
            requestTimeoutMs: deps.requestTimeoutMs,
            features: deps.features,
            targetLanguage,
          }),
        ];
      }
      const current = frames.at(-1);
      if (current === undefined) return;
      const slot = surface.open();
      if (slot === null) return;
      // A superseding run drew a new slot: the previous tree goes first.
      removeView();
      ensureStyles(slot);
      const win = slot.ownerDocument.defaultView;
      const refit = (): void => fitSlot(slot);
      win?.addEventListener('resize', refit);
      const showActive = (): void => {
        const active = frames.at(-1);
        if (active === undefined || signal.aborted || mine !== run) return;
        removeView();
        const navigation: CardNavigation = {
          canBack: frames.length > 1,
          lookup(input) {
            if (signal.aborted || mine !== run || frames.at(-1) !== active) return;
            const text = normalizeText(input.text);
            const before =
              input.contextBefore === undefined ? '' : normalizeText(input.contextBefore);
            const after = input.contextAfter === undefined ? '' : normalizeText(input.contextAfter);
            if (
              text.length === 0 ||
              text.length > LIMITS.maxSelectionChars ||
              before.length + after.length > LIMITS.maxContextChars
            )
              return;
            const childSnapshot: SelectionSnapshot = {
              selectionId: deps.newId(),
              source: snapshot.source,
              kind: classifySelection(text),
              text,
              ...(before === '' ? {} : { contextBefore: before }),
              ...(after === '' ? {} : { contextAfter: after }),
            };
            active.detach();
            frames.push(
              new ExplainSession({
                snapshot: childSnapshot,
                backend: deps.backend,
                newId: deps.newId,
                now: deps.now,
                requestTimeoutMs: deps.requestTimeoutMs,
                features: deps.features,
                targetLanguage,
              }),
            );
            showActive();
          },
          back() {
            if (signal.aborted || mine !== run || frames.at(-1) !== active || frames.length < 2)
              return;
            active.destroy();
            frames.pop();
            showActive();
          },
        };
        const host: CardHost = {
          keyboard: surface.keyboard,
          reposition: () => {
            refit();
            surface.reposition();
          },
          close: () => surface.close(),
          openSettings: (section) => deps.backend.openSettings(section),
          openSidePanel: (handoff) => deps.backend.openSidePanel(handoff),
          online: () => slot.ownerDocument.defaultView?.navigator.onLine !== false,
          copy: (text) => deps.copy(slot.ownerDocument, text),
          now: deps.now,
          ...(surface.speak === undefined ? {} : { speak: surface.speak }),
          ...(surface.speakerIcon === undefined ? {} : { speakerIcon: surface.speakerIcon }),
          navigation,
        };
        const removeCard = mountCard(slot, { session: active, host });
        unmount = removeCard;
        active.attach();
        refit();
      };
      win?.addEventListener('resize', refit);
      cleanupRun = () => win?.removeEventListener('resize', refit);
      showActive();
      signal.addEventListener(
        'abort',
        () => {
          // Only the run that currently shows the card may take it down.
          if (mine !== run) return;
          removeView();
          cleanupRun?.();
          cleanupRun = null;
          pendingDetach = setTimeout(() => {
            pendingDetach = undefined;
            if (mine === run) frames.at(-1)?.detach();
          }, 0);
        },
        { once: true },
      );
    },

    dismiss(selectionId) {
      if (
        selectionId === undefined ||
        rootSelectionId === selectionId ||
        pendingRootSelectionId === selectionId
      ) {
        run += 1;
        drop();
      }
    },

    destroy() {
      run += 1;
      drop();
    },
  };
}
