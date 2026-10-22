import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientError } from './errors';
import type { ClientResult } from './request';

export type ResourceState<T> =
  { status: 'loading' } | { status: 'ready'; data: T } | { status: 'error'; error: ClientError };

export interface Resource<T> {
  state: ResourceState<T>;
  /** Fetch again, showing the loading state. */
  reload(): void;
  /** Fetch again in the background, keeping what is on screen (and the user's focus) until it arrives. */
  refresh(): void;
  /** Replace the data with a fresher copy that an action already returned. */
  set(data: T): void;
}

/**
 * Load a value from the background once on mount. `load` must be a stable function (the
 * `api` wrappers are). Late answers from an earlier call or after unmount are dropped so a
 * slow reply can never overwrite a newer one.
 */
export function useResource<T>(load: () => Promise<ClientResult<T>>): Resource<T> {
  const [state, setState] = useState<ResourceState<T>>({ status: 'loading' });
  const latest = useRef(0);

  const run = useCallback(async () => {
    const id = ++latest.current;
    const result = await load();
    if (id !== latest.current) return;
    setState(
      result.ok ? { status: 'ready', data: result.data } : { status: 'error', error: result.error },
    );
  }, [load]);

  useEffect(() => {
    void run();
    return () => {
      latest.current += 1;
    };
  }, [run]);

  const reload = useCallback(() => {
    setState({ status: 'loading' });
    void run();
  }, [run]);

  const refresh = useCallback(() => {
    void run();
  }, [run]);

  const set = useCallback((data: T) => {
    latest.current += 1;
    setState({ status: 'ready', data });
  }, []);

  return { state, reload, refresh, set };
}
