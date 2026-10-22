import type { SelectionSnapshot } from '../contracts/selection';
import type { CapturedSelection } from './capture';

/** What the user chose in the toolbar. Spike B only records it. */
export interface ToolbarAction {
  action: 'listen' | 'explain';
  /** The snapshot captured at selection end, NOT re-read from the (possibly collapsed) selection. */
  snapshot: SelectionSnapshot;
  overLimit: boolean;
}

export interface ToolbarOptions {
  onAction?: (event: ToolbarAction) => void;
}

export interface ToolbarHandle {
  show(selection: CapturedSelection): void;
  hide(): void;
  /** True while a pointer press or keyboard focus is inside the toolbar (selection may collapse). */
  isInteracting(): boolean;
  /** Move keyboard focus to the first action (keyboard entry point; wired up in Phase 4). */
  focus(): void;
  destroy(): void;
}

/** What a lazily loaded UI script publishes for the observer (options a and b). */
export interface ContentUiModule {
  createToolbar(options: ToolbarOptions): ToolbarHandle;
}

/** Produces the toolbar, loading UI code first if it is not on the page yet. */
export type ToolbarLoader = (options: ToolbarOptions) => Promise<ToolbarHandle>;

/**
 * Observer and UI scripts share one isolated world per frame, so a symbol-keyed
 * global is the hand-off. Page scripts live in another world and cannot see it.
 */
export const UI_GLOBAL = Symbol.for('clavis.content-ui');
export const OBSERVER_GLOBAL = Symbol.for('clavis.observer');

export function getLoadedUi(): ContentUiModule | undefined {
  return (globalThis as Record<symbol, ContentUiModule | undefined>)[UI_GLOBAL];
}

export function publishUi(module: ContentUiModule): void {
  (globalThis as Record<symbol, unknown>)[UI_GLOBAL] = module;
}
