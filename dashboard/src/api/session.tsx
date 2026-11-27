import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { User } from '@shared/api-contract/endpoints';
import { ApiFailure, configureApi, isAbort, setCsrfToken } from './client';
import { api } from './endpoints';

export type SessionState =
  | { status: 'loading' }
  | { status: 'error'; failure: ApiFailure }
  | { status: 'signed-out'; ended: boolean }
  | { status: 'signed-in'; user: User };

interface SessionApi {
  state: SessionState;
  /** Re-run the session probe (after a network error). */
  retry(): void;
  /** Forget the session locally (after Sign out); `ended` shows the "session ended" notice. */
  clear(ended: boolean): void;
}

const Ctx = createContext<SessionApi | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<SessionState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  const clear = useCallback((ended: boolean) => {
    setCsrfToken(null);
    setState({ status: 'signed-out', ended });
  }, []);

  useEffect(() => {
    configureApi({
      // Any 401 from a page request: the cookie session is gone (expired, revoked, signed out elsewhere).
      onSessionLost: () => clear(true),
      refreshCsrf: async () => {
        try {
          const s = await api.session();
          return s.csrfToken;
        } catch {
          return null;
        }
      },
    });
  }, [clear]);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .session(ctl.signal)
      .then((s) => {
        setCsrfToken(s.csrfToken);
        setState({ status: 'signed-in', user: s.user });
      })
      .catch((e: unknown) => {
        if (isAbort(e)) return;
        if (e instanceof ApiFailure && e.kind === 'unauthenticated') {
          setState({ status: 'signed-out', ended: false });
        } else {
          setState({
            status: 'error',
            failure: e instanceof ApiFailure ? e : new ApiFailure('other', 0),
          });
        }
      });
    return () => ctl.abort();
  }, [attempt]);

  const value = useMemo<SessionApi>(
    () => ({
      state,
      retry: () => {
        setState({ status: 'loading' });
        setAttempt((n) => n + 1);
      },
      clear,
    }),
    [state, clear],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): SessionApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}
