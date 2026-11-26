import { useCallback, useEffect, useState } from 'react';
import { onDataChanged } from '../../lib/data/channel';
import type { StoreName } from '../../lib/data/db';

export type LoadState<T> =
  { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

/**
 * Read local data and read it again when another page (or this one) changes the named stores
 * (the `clavis-data` channel, design 4.1). A late answer from an older read never replaces a newer one.
 */
export function useLocalData<T>(
  read: () => Promise<T>,
  watch: readonly StoreName[],
): { state: LoadState<T>; reload(): void } {
  const [state, setState] = useState<LoadState<T>>({ status: 'loading' });
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion((v) => v + 1), []);

  useEffect(() => {
    let current = true;
    read().then(
      (data) => {
        if (current) setState({ status: 'ready', data });
      },
      () => {
        if (current) setState({ status: 'error' });
      },
    );
    return () => {
      current = false;
    };
    // `read` and `watch` are fixed per call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version]);

  useEffect(
    () => onDataChanged(reload, watch),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reload],
  );
  return { state, reload };
}
