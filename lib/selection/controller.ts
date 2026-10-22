import type { CapturedSelection } from './capture';
import { startSelectionObserver, type SelectionObserverOptions } from './observer';
import type { ToolbarAction, ToolbarHandle, ToolbarLoader } from './ui-api';

export interface SelectionControllerOptions {
  /** Loads (once) and returns the toolbar. Called on the first qualifying selection only. */
  loadToolbar: ToolbarLoader;
  /** Spike B: invoked for every toolbar click with the captured snapshot. */
  onAction?: (event: ToolbarAction) => void;
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

  function load(): Promise<ToolbarHandle | null> {
    loading ??= options
      .loadToolbar({ onAction: (event) => options.onAction?.(event) })
      .then(
        (handle) => {
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
    if (ready === null || current !== selection) return false;
    ready.show(selection);
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
      toolbar?.hide();
    },
  });

  return {
    async openForCurrentSelection(openOptions) {
      const captured = observer.captureNow();
      if (captured === null || !(await present(captured))) return false;
      if (openOptions?.focus === true) toolbar?.focus();
      return true;
    },
    stop() {
      observer.stop();
      toolbar?.destroy();
      toolbar = null;
      current = null;
    },
  };
}
