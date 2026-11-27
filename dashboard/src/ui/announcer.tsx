import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

const Ctx = createContext<(message: string) => void>(() => undefined);

/** A polite live region for outcomes that have no visible focus change ("Deleted", "Loaded 25 more"). */
export function AnnouncerProvider({ children }: { children: ReactNode }) {
  const [message, setMessage] = useState('');
  const [flip, setFlip] = useState(false);
  const announce = useCallback((m: string) => {
    setMessage(m);
    setFlip((f) => !f); // a different node each time, so an identical message is announced again
  }, []);
  const value = useMemo(() => announce, [announce]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        <span key={String(flip)}>{message}</span>
      </div>
    </Ctx.Provider>
  );
}

export const useAnnounce = (): ((message: string) => void) => useContext(Ctx);
