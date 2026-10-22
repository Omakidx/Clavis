/** PDF.js PasswordResponses (kept local so this module needs no PDF.js import). */
export const PASSWORD_NEEDED = 1;
export const PASSWORD_INCORRECT = 2;

export type PasswordPrompt = { incorrect: boolean };

type UpdatePassword = (password: string) => void;

/**
 * Bridges PDF.js `loadingTask.onPassword(updatePassword, reason)` to a UI prompt.
 *
 * The password is held only by the caller's `submit` argument: it is passed straight to
 * PDF.js and never stored, logged or put in an error. Only one request can be pending; a
 * new request (wrong password) replaces the previous callback.
 */
export class PasswordGate {
  #pending: UpdatePassword | null = null;
  readonly #onPrompt: (prompt: PasswordPrompt) => void;
  readonly #onCancel: () => void;

  constructor(onPrompt: (prompt: PasswordPrompt) => void, onCancel: () => void) {
    this.#onPrompt = onPrompt;
    this.#onCancel = onCancel;
  }

  /** Assign to `loadingTask.onPassword`. */
  readonly request = (updatePassword: UpdatePassword, reason: number): void => {
    this.#pending = updatePassword;
    this.#onPrompt({ incorrect: reason === PASSWORD_INCORRECT });
  };

  get isPending(): boolean {
    return this.#pending !== null;
  }

  /** Returns false when no password is being requested (stale submit). */
  submit(password: string): boolean {
    const pending = this.#pending;
    if (!pending) return false;
    this.#pending = null;
    pending(password);
    return true;
  }

  /** The user dismissed the prompt; the caller aborts the load. */
  cancel(): void {
    if (this.#pending === null) return;
    this.#pending = null;
    this.#onCancel();
  }

  /** Drop any pending callback without notifying (document closed or replaced). */
  reset(): void {
    this.#pending = null;
  }
}
