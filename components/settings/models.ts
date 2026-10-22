import type { ModelInfo, KeyStatus } from '../../lib/contracts/setup';

/** Why the model list may be short or stale, for the note under the drop-down. */
export type ModelListNote = 'no-key' | 'unchecked' | 'unverified' | null;

export interface ModelChoices {
  /** Models the key can use, in the order the background returned them. */
  models: readonly ModelInfo[];
  /** The saved model id, or undefined when Clavis's default is in use. */
  saved: string | undefined;
  /**
   * FR-005: the saved model is not in the list Groq returned. The UI must say so and make the
   * user choose; it never switches models by itself.
   */
  savedMissing: boolean;
  note: ModelListNote;
}

/**
 * Work out what the model drop-down shows. The saved model is only called "missing" when there
 * IS a verified list to compare against: an empty list (never checked, or offline) proves
 * nothing, so the saved choice is kept and the note explains why the list is empty.
 */
export function modelChoices(saved: string | undefined, key: KeyStatus | null): ModelChoices {
  const models = key?.models ?? [];
  const hasList = models.length > 0;
  const savedMissing =
    saved !== undefined && hasList && key?.verification !== 'invalid'
      ? !models.some((model) => model.id === saved)
      : false;

  let note: ModelListNote = null;
  if (key === null || !key.hasKey) note = 'no-key';
  else if (key.verification === 'unverified') note = 'unverified';
  else if (!hasList) note = 'unchecked';

  return { models, saved, savedMissing, note };
}
