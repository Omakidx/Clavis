import { describe, expect, it } from 'vitest';
import { DEFAULT_ONBOARDING } from '../../../lib/contracts';
import {
  STEPS,
  canAdvance,
  nextStep,
  previousStep,
  type WizardFacts,
} from '../../../components/onboarding/steps';

const facts = (patch: Partial<WizardFacts> = {}): WizardFacts => ({
  onboarding: { ...DEFAULT_ONBOARDING },
  hasKey: false,
  keySkipped: false,
  ...patch,
});

describe('wizard step logic', () => {
  it('runs purpose, disclosure, access, key, connect, preferences, practice, done', () => {
    expect(STEPS).toEqual([
      'purpose',
      'disclosure',
      'access',
      'get-key',
      'connect',
      'preferences',
      'practice',
      'done',
    ]);
    expect(nextStep('done')).toBe('done');
    expect(previousStep('purpose')).toBe('purpose');
    expect(nextStep('purpose')).toBe('disclosure');
    expect(previousStep('access')).toBe('disclosure');
  });

  it('cannot leave the disclosure before it is acknowledged (FR-002)', () => {
    expect(canAdvance('disclosure', facts())).toBe(false);
    expect(canAdvance('disclosure', facts({ onboarding: null }))).toBe(false);
    expect(
      canAdvance(
        'disclosure',
        facts({ onboarding: { ...DEFAULT_ONBOARDING, disclosureAcceptedAt: 5 } }),
      ),
    ).toBe(true);
  });

  it('needs an answer on website access, and "declined" is a valid answer (UJ-02b)', () => {
    expect(canAdvance('access', facts())).toBe(false);
    for (const choice of ['granted', 'declined'] as const) {
      expect(
        canAdvance(
          'access',
          facts({ onboarding: { ...DEFAULT_ONBOARDING, siteAccessChoice: choice } }),
        ),
      ).toBe(true);
    }
  });

  it('lets setup finish without a key (UJ-05)', () => {
    expect(canAdvance('get-key', facts())).toBe(true);
    expect(canAdvance('connect', facts())).toBe(false);
    expect(canAdvance('connect', facts({ keySkipped: true }))).toBe(true);
    expect(canAdvance('connect', facts({ hasKey: true }))).toBe(true);
    expect(canAdvance('preferences', facts())).toBe(true);
    expect(canAdvance('practice', facts())).toBe(true);
  });

  it('does not advance past the last step', () => {
    expect(canAdvance('done', facts())).toBe(false);
  });
});
