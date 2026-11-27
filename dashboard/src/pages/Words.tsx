import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import type { WordSummary } from '@shared/api-contract/endpoints';
import { ApiFailure, describeFailure, isAbort } from '../api/client';
import { api } from '../api/endpoints';
import { PAGE_SIZE } from '../config';
import { formatCount, formatDate } from '../format';
import { useAnnounce } from '../ui/announcer';
import { ConfirmDialog } from '../ui/modal';
import { Empty, ErrorState, Loading, usePage } from '../ui/page';

interface ListState {
  status: 'loading' | 'ready' | 'error';
  items: WordSummary[];
  next: string | null;
  failure: unknown;
  more: 'idle' | 'loading' | 'error';
  moreFailure: unknown;
}
const initial: ListState = {
  status: 'loading',
  items: [],
  next: null,
  failure: null,
  more: 'idle',
  moreFailure: null,
};

function wordsParams(
  q: string,
  rest: { cursor?: string; limit: number },
): { q?: string; cursor?: string; limit: number } {
  return {
    ...(q ? { q } : {}),
    ...(rest.cursor ? { cursor: rest.cursor } : {}),
    limit: rest.limit,
  };
}

function sourceLabel(w: WordSummary): string {
  const s = w.source;
  if (s.kind === 'pdf') return `PDF${s.title ? `: ${s.title}` : ''} · page ${s.page}`;
  return s.title ?? 'Web page';
}

export function Words() {
  const search = useSearch();
  const [, navigate] = useLocation();
  const q = new URLSearchParams(search).get('q') ?? '';
  const heading = usePage('Saved words');
  const [reloadTick, setReloadTick] = useState(0);

  // What the user typed, and the URL query it was typed against. When the URL changes for another
  // reason (Back/Forward), `base` no longer matches and the box shows the URL's query again.
  const [edit, setEdit] = useState<{ base: string; text: string } | null>(null);
  const draft = edit && edit.base === q ? edit.text : q;
  const setDraft = (text: string): void => setEdit({ base: q, text });

  // Debounced search-as-you-type: the URL changes (replace, so Back does not step through keystrokes).
  useEffect(() => {
    const trimmed = draft.trim();
    if (trimmed === q.trim()) return;
    const id = window.setTimeout(() => {
      setEdit({ base: trimmed, text: draft });
      navigate(trimmed ? `/words?q=${encodeURIComponent(trimmed)}` : '/words', { replace: true });
    }, 350);
    return () => window.clearTimeout(id);
  }, [draft, q, navigate]);

  const onSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    setEdit({ base: trimmed, text: draft });
    navigate(trimmed ? `/words?q=${encodeURIComponent(trimmed)}` : '/words', { replace: true });
  };

  const searching = q.trim() !== '';

  return (
    <section>
      <h1 ref={heading} tabIndex={-1}>
        Saved words
      </h1>
      <form role="search" className="search" onSubmit={onSubmit}>
        <label htmlFor="word-search">Search saved words</label>
        <div className="search__row">
          <input
            id="word-search"
            type="search"
            value={draft}
            maxLength={100}
            autoComplete="off"
            onChange={(e) => setDraft(e.target.value)}
          />
          <button type="submit" className="btn btn--quiet">
            Search
          </button>
        </div>
      </form>
      <WordList
        key={`${q.trim()}|${reloadTick}`}
        q={q.trim()}
        searching={searching}
        onReload={() => setReloadTick((n) => n + 1)}
      />
    </section>
  );
}

function WordList({ q, searching, onReload }: { q: string; searching: boolean; onReload(): void }) {
  const announce = useAnnounce();
  const [state, setState] = useState<ListState>(initial);
  const [pendingDelete, setPendingDelete] = useState<WordSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const moreCtl = useRef<AbortController | null>(null);
  useEffect(() => () => moreCtl.current?.abort(), []);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .words(wordsParams(q, { limit: PAGE_SIZE }), ctl.signal)
      .then((r) => setState({ ...initial, status: 'ready', items: r.items, next: r.nextCursor }))
      .catch((e: unknown) => {
        if (!isAbort(e)) setState({ ...initial, status: 'error', failure: e });
      });
    return () => ctl.abort();
  }, [q]);

  const loadMore = useCallback(() => {
    if (!state.next || state.more === 'loading') return;
    const ctl = new AbortController();
    moreCtl.current = ctl;
    const cursor = state.next;
    setState((s) => ({ ...s, more: 'loading', moreFailure: null }));
    api
      .words(wordsParams(q, { cursor, limit: PAGE_SIZE }), ctl.signal)
      .then((r) => {
        setState((s) => {
          const seen = new Set(s.items.map((w) => w.key));
          return {
            ...s,
            items: [...s.items, ...r.items.filter((w) => !seen.has(w.key))],
            next: r.nextCursor,
            more: 'idle',
          };
        });
        announce(`Loaded ${r.items.length} more word${r.items.length === 1 ? '' : 's'}.`);
      })
      .catch((e: unknown) => {
        if (!isAbort(e)) setState((s) => ({ ...s, more: 'error', moreFailure: e }));
      });
  }, [state.next, state.more, q, announce]);

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.deleteWord(pendingDelete.key);
    } catch (e) {
      // 404 means it is already gone (deleted elsewhere): the list should drop it too.
      if (!(e instanceof ApiFailure && e.kind === 'not-found')) {
        setDeleteError(e);
        setDeleting(false);
        return;
      }
    }
    const gone = pendingDelete;
    setState((s) => ({ ...s, items: s.items.filter((w) => w.key !== gone.key) }));
    setPendingDelete(null);
    setDeleting(false);
    announce(`Deleted ${gone.text}.`);
    listHeading.current?.focus();
    // The first page is now empty but more exist: fetch the next page instead of claiming there are none.
    if (state.items.length === 1 && state.next) loadMore();
  };

  return (
    <>
      <h2 className="sr-only" tabIndex={-1} ref={listHeading}>
        {searching ? `Results for ${q}` : 'All saved words'}
      </h2>

      {state.status === 'loading' ? <Loading label="Loading saved words…" /> : null}
      {state.status === 'error' ? (
        <ErrorState failure={state.failure} onRetry={() => onReload()} />
      ) : null}
      {state.status === 'ready' && state.items.length === 0 && !state.next ? (
        <Empty>
          {searching ? (
            <p>No saved words match “{q}”.</p>
          ) : (
            <>
              <p>You have no saved words yet.</p>
              <p className="muted">
                Select text on a page, open the Clavis lookup card and choose Save. Saved words
                appear here once you are signed in to sync in the extension.
              </p>
            </>
          )}
        </Empty>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 && state.next ? (
        state.more === 'error' ? (
          <ErrorState failure={state.moreFailure} onRetry={loadMore} />
        ) : (
          <Loading label="Loading more words…" />
        )
      ) : null}
      {state.status === 'ready' && state.items.length > 0 ? (
        <>
          <p className="muted" data-testid="words-count">
            {state.next
              ? `Showing ${formatCount(state.items.length)} words`
              : `${formatCount(state.items.length)} word${state.items.length === 1 ? '' : 's'}`}
          </p>
          <ul className="cards" aria-label="Saved words">
            {state.items.map((w) => (
              <li key={w.key} className="card">
                <div className="card__main">
                  <h3 className="card__title">
                    <Link href={`/words/${w.key}`}>{w.text}</Link>
                  </h3>
                  {w.summary ? <p className="clamp">{w.summary}</p> : null}
                  <p className="meta">
                    <span>{sourceLabel(w)}</span>
                    <span>Saved {formatDate(w.createdAt)}</span>
                    {w.messageCount > 0 ? (
                      <span>
                        {formatCount(w.messageCount)} chat message{w.messageCount === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </p>
                </div>
                <button
                  type="button"
                  className="btn btn--quiet btn--small"
                  aria-label={`Delete ${w.text}`}
                  onClick={() => {
                    setDeleteError(null);
                    setPendingDelete(w);
                  }}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
          {state.more === 'error' ? (
            <ErrorState
              failure={state.moreFailure}
              {...(state.moreFailure instanceof ApiFailure && state.moreFailure.kind === 'gone'
                ? { onRetry: () => onReload(), label: 'Reload list' }
                : { onRetry: loadMore })}
            />
          ) : null}
          {state.next && state.more !== 'error' ? (
            <p>
              <button
                type="button"
                className="btn btn--quiet"
                disabled={state.more === 'loading'}
                onClick={loadMore}
              >
                {state.more === 'loading' ? 'Loading…' : 'Load more'}
              </button>
            </p>
          ) : null}
        </>
      ) : null}

      {pendingDelete ? (
        <ConfirmDialog
          title="Delete this saved word?"
          confirmLabel="Delete word"
          busy={deleting}
          onConfirm={() => void confirmDelete()}
          onCancel={() => setPendingDelete(null)}
        >
          <p>
            “{pendingDelete.text}” and its chat will be deleted from your account and from your
            other devices. This cannot be undone.
          </p>
          {deleteError ? (
            <p className="notice notice--danger" role="alert">
              {describeFailure(deleteError)}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </>
  );
}
