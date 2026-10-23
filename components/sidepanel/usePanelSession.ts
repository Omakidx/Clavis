import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FEATURES } from '../../lib/config/constants';
import type { SidePanelHandoff } from '../../lib/contracts';
import type { ExplainBackend } from '../explanation/backend';
import { ExplainSession, type SessionState } from '../explanation/session';
import { handoffResults } from './text';

/**
 * One `ExplainSession` per selection shown in the panel: the same state machine as the card (lazy
 * tabs, in-memory cache per selection, one request at a time, Retry only when the user asks), so
 * the panel behaves like the card. It starts from the results the card had loaded and sends
 * nothing by itself: `attach({ requestCore: false })`.
 *
 * A newer hand-off for the SAME selection (the user loaded more tabs in the card and pressed
 * "Open in side panel" again) is merged into the running session: what the panel loaded itself
 * stays. A different selection replaces the session and cancels what it had pending.
 */
export function usePanelSession(
  handoff: SidePanelHandoff | null,
  backend: ExplainBackend,
  newId: () => string,
  now: () => number,
): { session: ExplainSession | null; state: SessionState | null } {
  const current = useRef<ExplainSession | null>(null);
  const [session, setSession] = useState<ExplainSession | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (handoff === null) {
        current.current?.destroy();
        current.current = null;
        setSession(null);
        return;
      }
      const existing = current.current;
      if (existing !== null && existing.selectionId === handoff.snapshot.selectionId) {
        existing.seed(handoffResults(handoff), handoff.active);
        return;
      }
      // The Translate tab needs the language; only when that tab is switched on.
      const language =
        handoff.targetLanguage ??
        (FEATURES.translateTab ? await backend.explanationLanguage() : undefined);
      if (cancelled) return;
      existing?.destroy();
      const next = new ExplainSession({
        snapshot: handoff.snapshot,
        backend,
        newId,
        now,
        features: FEATURES,
        targetLanguage: language,
      });
      next.seed(handoffResults(handoff), handoff.active);
      next.attach({ requestCore: false });
      current.current = next;
      setSession(next);
    })();
    return () => {
      cancelled = true;
    };
  }, [handoff, backend, newId, now]);

  useEffect(
    () => () => {
      current.current?.destroy();
      current.current = null;
    },
    [],
  );

  const subscribe = useCallback(
    (onChange: () => void) => session?.subscribe(onChange) ?? (() => undefined),
    [session],
  );
  const state = useSyncExternalStore(subscribe, () => session?.state ?? null);

  return { session, state };
}
