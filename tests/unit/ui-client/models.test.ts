import { describe, expect, it } from 'vitest';
import type { KeyStatus } from '../../../lib/contracts';
import { modelChoices } from '../../../components/settings/models';

const key = (patch: Partial<KeyStatus> = {}): KeyStatus => ({
  hasKey: true,
  storage: 'local',
  last4: '1234',
  verification: 'valid',
  verifiedAt: 1,
  models: [
    { id: 'a/model-1', supportsJsonSchema: true },
    { id: 'b/model-2', supportsJsonSchema: false },
  ],
  ...patch,
});

describe('modelChoices (FR-005)', () => {
  it('uses the default and no warning when nothing is saved', () => {
    expect(modelChoices(undefined, key())).toMatchObject({
      saved: undefined,
      savedMissing: false,
      note: null,
    });
  });
  it('accepts a saved model that the key can use', () => {
    expect(modelChoices('a/model-1', key()).savedMissing).toBe(false);
  });
  it('flags a saved model that is absent from the verified list (never auto-switches)', () => {
    const choices = modelChoices('gone/model', key());
    expect(choices.savedMissing).toBe(true);
    expect(choices.saved).toBe('gone/model');
  });
  it('does not call a model missing when there is no list to compare with', () => {
    expect(modelChoices('x/y', key({ models: [], verification: 'never' }))).toMatchObject({
      savedMissing: false,
      note: 'unchecked',
    });
    expect(modelChoices('x/y', key({ models: [], verification: 'unverified' }))).toMatchObject({
      savedMissing: false,
      note: 'unverified',
    });
  });
  it('explains the empty list when there is no key at all', () => {
    expect(modelChoices(undefined, null).note).toBe('no-key');
    expect(
      modelChoices(undefined, key({ hasKey: false, models: [], last4: null, storage: null })).note,
    ).toBe('no-key');
  });
});
