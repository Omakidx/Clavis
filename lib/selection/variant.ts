/**
 * Spike B build-time switch for the UI loading strategy (D-08, architecture section 5):
 *   a = background injection, b = dynamic import of a web-accessible chunk,
 *   c = Preact toolbar bundled in the observer (RECOMMENDED, the default).
 * Set `VITE_CLAVIS_TOOLBAR_VARIANT` when building to measure the others. The numbers are in
 * docs/decisions/spike-b-toolbar.md; Phase 4 deletes the switch and keeps the winner.
 */
export type ToolbarVariant = 'a' | 'b' | 'c';

export function toolbarVariant(): ToolbarVariant {
  const value: unknown = import.meta.env.VITE_CLAVIS_TOOLBAR_VARIANT;
  return value === 'a' || value === 'b' ? value : 'c';
}
