import type { KeyStatusHook } from '../../lib/ui-client/use-key-status';
import type { SettingsHook } from '../../lib/ui-client/use-settings';
import type { StepId } from './steps';

/** What every step receives from the wizard. */
export interface StepContext {
  settings: SettingsHook;
  keys: KeyStatusHook;
  /** The user chose "Set up later" on a key step. */
  skipKey(): void;
  goTo(step: StepId): void;
  /** Ask the wizard to move focus to its Next button (after an action that unlocks it). */
  focusNext(): void;
}
