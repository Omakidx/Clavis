import type { CapturedSelection } from './capture';
import { sameRange, startSelectionObserver, type SelectionObserverOptions } from './observer';
import type { ToolbarActions, ToolbarHandle, ToolbarLoader } from './ui-api';

export interface SelectionControllerOptions {
  /** Loads (once) and returns the toolbar. Called on the first qualifying selection only. */
  loadToolbar: ToolbarLoader;
  /** What Listen, Explain, the trim button and dismissal do (Phases 5 and 6 plug in here). */
  actions?: ToolbarActions;
  /** Test seam for the observer. */
  observerTimings?: SelectionObserverOptions['timings'];
  win?: Window;
}

export interface SelectionController {
  /**
   * Context-menu / toolbar-icon path: capture whatever is selected now and show
   * the toolbar for it. Resolves to whether a toolbar was shown.
   */
  openForCurrentSelection(options?: { focus?: boolean }): Promise<boolean>;
  /** Show a message that is not about a selection (see `ToolbarHandle.showNotice`). */
  showNotice(message: string): Promise<boolean>;
  stop(): void;
}

/**
 * Glue between observer and toolbar (architecture section 5, state machine):
 * Idle -> Selected -> ToolbarVisible, with a stale-selection guard around the
 * lazy UI load so a slow load can never show an old selection.
 */
export function createSelectionController(
  options: SelectionControllerOptions,
): SelectionController {
  let toolbar: ToolbarHandle | null = null;
  let loading: Promise<ToolbarHandle | null> | null = null;
  /** The selection the user currently has; null once it was cleared. */
  let current: CapturedSelection | null = null;
  /** The toolbar is showing `current` (set on show, cleared on every dismissal). */
  let shown = false;
  let stopped = false;

  function load(): Promise<ToolbarHandle | null> {
    loading ??= options
      .loadToolbar({
        actions: {
          ...options.actions,
          dismiss(context) {
            shown = false;
            if (context.reason === 'escape') observer.allowReshow();
            options.actions?.dismiss?.(context);
          },
        },
      })
      .then(
        (handle) => {
          if (stopped) {
            handle.destroy();
            return null;
          }
          toolbar = handle;
          return handle;
        },
        (error: unknown) => {
          // Retry on the next selection. Never log selection text (FR-073).
          console.warn(
            'Clavis: toolbar UI failed to load',
            error instanceof Error ? error.name : '',
          );
          return null;
        },
      )
      .finally(() => {
        loading = null;
      });
    return loading;
  }

  async function present(selection: CapturedSelection): Promise<boolean> {
    current = selection;
    const ready = toolbar ?? (await load());
    // Stale guard: the selection may have changed or gone while the UI loaded.
    if (ready === null || current !== selection || stopped) return false;
    ready.show(selection);
    shown = true;
    return true;
  }

  const observer = startSelectionObserver({
    ...(options.win === undefined ? {} : { win: options.win }),
    ...(options.observerTimings === undefined ? {} : { timings: options.observerTimings }),
    onSelection(selection) {
      void present(selection);
    },
    onClear() {
      // Clicking a toolbar button can collapse the selection; that must not dismiss it (FR-014).
      if (toolbar?.isInteracting() === true) return;
      current = null;
      shown = false;
      toolbar?.hide('cleared');
    },
  });

  return {
    async openForCurrentSelection(openOptions) {
      const captured = observer.captureNow();
      if (captured === null) return false;
      // The same selection is already showing: keep its snapshot (a new one would mint a new
      // `selectionId` and wipe the card); only move focus when asked.
      const reuse = shown && current !== null && sameRange(current.range, captured.range);
      if (!reuse && !(await present(captured))) return false;
      if (openOptions?.focus === true) toolbar?.focus();
      return true;
    },
    async showNotice(message) {
      current = null;
      const ready = toolbar ?? (await load());
      if (ready === null || stopped) return false;
      ready.showNotice(message);
      return true;
    },
    stop() {
      stopped = true;
      shown = false;
      observer.stop();
      toolbar?.destroy();
      toolbar = null;
      current = null;
    },
  };
}
