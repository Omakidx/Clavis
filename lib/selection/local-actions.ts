import type { RunContext, ToolbarActions } from './ui-api';

/** How long a button shows its working state in Phase 4. */
const LOCAL_WORKING_MS = 700;

/**
 * Phase 4 controller: Listen and Explain only drive the toolbar's own visual states (button
 * pressed for a moment, then reset). It sends nothing: no background message, no AI call, no
 * speech (FR-017). Phases 5 and 6 replace `listen` and `explain` with real implementations.
 */
export function createLocalActions(workingMs: number = LOCAL_WORKING_MS): ToolbarActions {
  // Ends early when the run is no longer wanted (superseded, replaced or dismissed).
  const pause = ({ signal }: RunContext): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(resolve, workingMs);
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  return { listen: pause, explain: pause };
}
