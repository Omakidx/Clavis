import { FEATURES } from '../../lib/config/constants';
import type { ExplainCardApi, RunContext } from '../../lib/selection/ui-api';
import { newSelectionId } from '../../lib/selection/ids';
import { createBackend, type ExplainBackend } from './backend';
import css from './card.css?inline';
import { copyPlainText } from './copy';
import { mountCard, type CardHost } from './ExplanationCard';
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

/**
 * The explanation card (D-08): loaded separately from the always-on observer, it draws inside the
 * toolbar's closed shadow root through the `CardSurface` the toolbar lends (lib/selection/ui-api.ts).
 *
 * One selection has one `ExplainSession` (cache, queue, request state). Pressing Explain again on the
 * same selection re-shows the cached card without a new request; another selection, a dismissal or a
 * trim discards it. The run's `AbortSignal` ties the card to the toolbar: aborting it (superseded,
 * replaced, dismissed, closed) removes the card and cancels what is pending.
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
  let session: ExplainSession | null = null;
  /** Removes the card from the surface it is showing in. */
  let unmount: (() => void) | null = null;

  function removeView(): void {
    unmount?.();
    unmount = null;
  }

  function drop(): void {
    clearTimeout(pendingDetach);
    pendingDetach = undefined;
    removeView();
    session?.destroy();
    session = null;
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
      clearTimeout(pendingDetach);
      pendingDetach = undefined;

      if (session?.selectionId !== snapshot.selectionId) {
        drop();
        // Only the Translate tab needs it, and that tab is behind a feature flag.
        const targetLanguage = deps.features?.translateTab
          ? await deps.backend.explanationLanguage()
          : undefined;
        // The user may have moved on while the language was looked up.
        if (signal.aborted || mine !== run) return;
        session = new ExplainSession({
          snapshot,
          backend: deps.backend,
          newId: deps.newId,
          now: deps.now,
          requestTimeoutMs: deps.requestTimeoutMs,
          features: deps.features,
          targetLanguage,
        });
      }
      const current = session;
      if (current === null) return;
      const slot = surface.open();
      if (slot === null) return;
      // A superseding run drew a new slot: the previous tree goes first.
      removeView();
      ensureStyles(slot);
      const host: CardHost = {
        keyboard: surface.keyboard,
        reposition: () => surface.reposition(),
        close: () => surface.close(),
        openSettings: (section) => deps.backend.openSettings(section),
        copy: (text) => deps.copy(slot.ownerDocument, text),
        now: deps.now,
      };
      unmount = mountCard(slot, { session: current, host });
      current.attach();
      signal.addEventListener(
        'abort',
        () => {
          // Only the run that currently shows the card may take it down.
          if (mine !== run) return;
          removeView();
          pendingDetach = setTimeout(() => {
            pendingDetach = undefined;
            if (mine === run) current.detach();
          }, 0);
        },
        { once: true },
      );
    },

    dismiss(selectionId) {
      if (selectionId === undefined || session?.selectionId === selectionId) drop();
    },

    destroy: drop,
  };
}
