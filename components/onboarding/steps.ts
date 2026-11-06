import type { OnboardingState } from '../../lib/contracts/setup';
import type { MessageKey } from '../../lib/i18n';

/** The wizard's steps in order (UJ-01). */
export const STEPS = [
  'purpose',
  'disclosure',
  'access',
  'connect',
  'preferences',
  'practice',
  'done',
] as const;
export type StepId = (typeof STEPS)[number];

/** Short name for the progress list. */
export const STEP_NAME = {
  purpose: 'onbStepPurpose',
  disclosure: 'onbStepDisclosure',
  access: 'onbStepAccess',
  connect: 'onbStepConnect',
  preferences: 'onbStepPrefs',
  practice: 'onbStepPractice',
  done: 'onbStepDone',
} as const satisfies Record<StepId, MessageKey>;

/** Heading shown (and focused) when the step opens. */
export const STEP_HEADING = {
  purpose: 'onbPurposeTitle',
  disclosure: 'disclosureTitle',
  access: 'siteAccessTitle',
  connect: 'onbConnectTitle',
  preferences: 'onbPrefsTitle',
  practice: 'onbPracticeTitle',
  done: 'onbDoneTitle',
} as const satisfies Record<StepId, MessageKey>;

/** What the wizard knows when deciding whether a step may be left. */
export interface WizardFacts {
  /** Persisted onboarding state; null while it has not loaded (or could not be loaded). */
  onboarding: OnboardingState | null;
  /** A Groq key is saved (verified or not). */
  hasKey: boolean;
  /** The user chose "Set up later" on the key steps. */
  keySkipped: boolean;
}

/**
 * Whether "Next" is offered on a step.
 *  - The disclosure must be acknowledged first (FR-002): there is no way around "I understand".
 *  - Website access needs an answer, but "Not now" is an answer (UJ-02b).
 *  - Groq setup can always be skipped (UJ-05), so the key steps never block finishing.
 */
export function canAdvance(step: StepId, facts: WizardFacts): boolean {
  switch (step) {
    case 'disclosure':
      return facts.onboarding?.disclosureAcceptedAt != null;
    case 'access':
      return facts.onboarding !== null && facts.onboarding.siteAccessChoice !== 'unset';
    case 'connect':
      return facts.hasKey || facts.keySkipped;
    case 'preferences':
      return facts.onboarding !== null;
    case 'done':
      return false;
    default:
      return true;
  }
}

export function nextStep(step: StepId): StepId {
  const index = STEPS.indexOf(step);
  return STEPS[Math.min(index + 1, STEPS.length - 1)] ?? step;
}

export function previousStep(step: StepId): StepId {
  const index = STEPS.indexOf(step);
  return STEPS[Math.max(index - 1, 0)] ?? step;
}
