import { useCallback } from 'react';
import type { PreferencesPatch, SettingsSnapshot } from '../contracts/setup';
import { api } from './api';
import type { ClientResult } from './request';
import { useResource, type Resource } from './use-resource';

export interface SettingsHook {
  resource: Resource<SettingsSnapshot>;
  /** Save a partial change; on success the page shows what the background actually stored. */
  save(patch: PreferencesPatch): Promise<ClientResult<SettingsSnapshot>>;
  reset(): Promise<ClientResult<SettingsSnapshot>>;
  /** Run any action that returns a fresh snapshot (disclosure, onboarding) and adopt it. */
  adopt(action: Promise<ClientResult<SettingsSnapshot>>): Promise<ClientResult<SettingsSnapshot>>;
}

/** Preferences and onboarding state from the background (GET_SETTINGS and its updates). */
export function useSettings(): SettingsHook {
  const resource = useResource(api.getSettings);
  const { set } = resource;

  const adopt = useCallback(
    async (action: Promise<ClientResult<SettingsSnapshot>>) => {
      const result = await action;
      if (result.ok) set(result.data);
      return result;
    },
    [set],
  );

  const save = useCallback(
    (patch: PreferencesPatch) => adopt(api.updatePreferences(patch)),
    [adopt],
  );
  const reset = useCallback(() => adopt(api.resetPreferences()), [adopt]);

  return { resource, save, reset, adopt };
}
