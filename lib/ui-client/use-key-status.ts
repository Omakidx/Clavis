import { useCallback, useState } from 'react';
import type { KeyStorage } from '../contracts/key-storage';
import type { KeyStatus } from '../contracts/setup';
import { api } from './api';
import type { ClientResult } from './request';
import { connectKey, testKey, type KeyOutcome } from './key-flow';
import { useResource, type Resource } from './use-resource';

export type KeyBusy = 'idle' | 'connecting' | 'testing' | 'removing';

export interface KeyStatusHook {
  resource: Resource<KeyStatus>;
  busy: KeyBusy;
  /** Save the key and verify it. Refreshes the status afterwards even when the check fails. */
  connect(apiKey: string, storage: KeyStorage): Promise<KeyOutcome>;
  test(): Promise<KeyOutcome>;
  remove(): Promise<ClientResult<KeyStatus>>;
}

/** Key status plus the key actions, for the options and onboarding pages. Never holds a key. */
export function useKeyStatus(): KeyStatusHook {
  const resource = useResource(api.getKeyStatus);
  const [busy, setBusy] = useState<KeyBusy>('idle');
  const { set } = resource;

  /** After an outcome with no status (a failed check), ask the background for the truth. */
  const settle = useCallback(
    async (outcome: KeyOutcome): Promise<KeyOutcome> => {
      if ('status' in outcome && outcome.status !== null) {
        set(outcome.status);
      } else {
        const fresh = await api.getKeyStatus();
        if (fresh.ok) set(fresh.data);
      }
      return outcome;
    },
    [set],
  );

  const connect = useCallback(
    async (apiKey: string, storage: KeyStorage) => {
      setBusy('connecting');
      try {
        return await settle(await connectKey(apiKey, storage));
      } finally {
        setBusy('idle');
      }
    },
    [settle],
  );

  const test = useCallback(async () => {
    setBusy('testing');
    try {
      return await settle(await testKey());
    } finally {
      setBusy('idle');
    }
  }, [settle]);

  const remove = useCallback(async () => {
    setBusy('removing');
    try {
      const result = await api.removeApiKey();
      if (result.ok) set(result.data);
      return result;
    } finally {
      setBusy('idle');
    }
  }, [set]);

  return { resource, busy, connect, test, remove };
}
