/** Find-in-document status as reported by PDF.js's PDFFindController (FR-057). */
export interface FindStatus {
  state: 'idle' | 'pending' | 'found' | 'not-found' | 'wrapped';
  current: number;
  total: number;
}

export const IDLE_FIND: FindStatus = { state: 'idle', current: 0, total: 0 };

/** PDF.js `FindState` values (0..3) by index; kept local so this module needs no PDF.js import. */
const FIND_STATES = ['found', 'not-found', 'wrapped', 'pending'] as const;

/** Map PDF.js's numeric find state to ours; an unknown number is treated as `found`. */
export function findStateName(state: number): FindStatus['state'] {
  return FIND_STATES[state] ?? 'found';
}

/** What the find bar says next to the box. `none` = nothing (no query, or no result yet). */
export type FindSummary =
  | { kind: 'none' }
  | { kind: 'pending' }
  | { kind: 'not-found' }
  | { kind: 'count'; current: number; total: number; wrapped: boolean };

/** Reduce the controller's status to what the UI shows; an empty query never shows a result. */
export function summarizeFind(find: FindStatus, query: string): FindSummary {
  if (query.trim() === '') return { kind: 'none' };
  if (find.state === 'not-found') return { kind: 'not-found' };
  if (find.state === 'pending') return { kind: 'pending' };
  if (find.total > 0) {
    return {
      kind: 'count',
      current: find.current,
      total: find.total,
      wrapped: find.state === 'wrapped',
    };
  }
  return { kind: 'none' };
}

export interface FindRequest {
  query: string;
  caseSensitive: boolean;
}

/**
 * Whether a find-bar edit should (re)start a search: only a changed, non-blank query or a changed
 * case-sensitivity re-runs it; pressing Enter steps to the next match instead (`again`).
 */
export function isNewSearch(previous: FindRequest | null, next: FindRequest): boolean {
  if (next.query.trim() === '') return false;
  return (
    previous === null ||
    previous.query !== next.query ||
    previous.caseSensitive !== next.caseSensitive
  );
}
