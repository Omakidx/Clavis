import { useCallback, useEffect, useRef, useState } from 'react';
import type { AccountResponse, DocumentView } from '@shared/api-contract/endpoints';
import { ApiFailure, describeFailure, isAbort } from '../api/client';
import { api, fileUrl } from '../api/endpoints';
import { PAGE_SIZE } from '../config';
import { formatBytes, formatCount, formatDate } from '../format';
import { useAnnounce } from '../ui/announcer';
import { ConfirmDialog } from '../ui/modal';
import { Empty, ErrorState, Loading, usePage } from '../ui/page';

interface ListState {
  status: 'loading' | 'ready' | 'error';
  items: DocumentView[];
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

type Pending = { kind: 'remove-file' | 'delete'; doc: DocumentView };

function Quota({
  usage,
  failure,
  retry,
}: {
  usage: AccountResponse['usage'] | null;
  failure: unknown;
  retry(): void;
}) {
  if (failure) return <ErrorState failure={failure} onRetry={retry} />;
  if (!usage) return <Loading label="Loading storage…" />;
  const pct =
    usage.storageQuotaBytes > 0
      ? Math.min(100, (usage.storageUsedBytes / usage.storageQuotaBytes) * 100)
      : 0;
  return (
    <div className="quota">
      <label htmlFor="quota-bar" className="quota__label">
        Stored PDFs: {formatBytes(usage.storageUsedBytes)} of {formatBytes(usage.storageQuotaBytes)}{' '}
        used
      </label>
      <progress
        id="quota-bar"
        max={usage.storageQuotaBytes}
        value={usage.storageUsedBytes}
        data-near-full={pct >= 90 ? 'true' : undefined}
        data-testid="quota-bar"
      />
    </div>
  );
}

function progressOf(d: DocumentView): { text: string; value: number | null; max: number | null } {
  if (d.lastPage && d.pageCount)
    return { text: `Page ${d.lastPage} of ${d.pageCount}`, value: d.lastPage, max: d.pageCount };
  if (d.lastPage) return { text: `Page ${d.lastPage}`, value: null, max: null };
  return {
    text: d.pageCount ? `Not started · ${d.pageCount} pages` : 'Not started',
    value: null,
    max: null,
  };
}

export function Documents() {
  const [tick, setTick] = useState(0);
  return <DocumentsLoaded key={tick} onReload={() => setTick((n) => n + 1)} />;
}

function DocumentsLoaded({ onReload }: { onReload(): void }) {
  const heading = usePage('Documents');
  const announce = useAnnounce();
  const [state, setState] = useState<ListState>(initial);
  const [usage, setUsage] = useState<AccountResponse['usage'] | null>(null);
  const [usageFailure, setUsageFailure] = useState<unknown>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);

  const loadUsage = useCallback((signal?: AbortSignal) => {
    api
      .account(signal)
      .then((a) => setUsage(a.usage))
      .catch((e: unknown) => {
        if (!isAbort(e)) setUsageFailure(e);
      });
  }, []);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .documents({ limit: PAGE_SIZE }, ctl.signal)
      .then((r) => setState({ ...initial, status: 'ready', items: r.items, next: r.nextCursor }))
      .catch((e: unknown) => {
        if (!isAbort(e)) setState({ ...initial, status: 'error', failure: e });
      });
    loadUsage(ctl.signal);
    return () => ctl.abort();
  }, [loadUsage]);

  const loadMore = (): void => {
    if (!state.next || state.more === 'loading') return;
    setState((s) => ({ ...s, more: 'loading', moreFailure: null }));
    api
      .documents({ cursor: state.next, limit: PAGE_SIZE })
      .then((r) => {
        setState((s) => {
          const seen = new Set(s.items.map((d) => d.fingerprint));
          return {
            ...s,
            items: [...s.items, ...r.items.filter((d) => !seen.has(d.fingerprint))],
            next: r.nextCursor,
            more: 'idle',
          };
        });
        announce(`Loaded ${r.items.length} more document${r.items.length === 1 ? '' : 's'}.`);
      })
      .catch((e: unknown) => setState((s) => ({ ...s, more: 'error', moreFailure: e })));
  };

  const run = async (): Promise<void> => {
    if (!pending) return;
    const { kind, doc } = pending;
    const name = doc.title ?? 'Untitled PDF';
    setBusy(true);
    setActionError(null);
    try {
      if (kind === 'delete') await api.deleteDocument(doc.fingerprint);
      else await api.deleteDocumentFile(doc.fingerprint);
    } catch (e) {
      if (!(e instanceof ApiFailure && e.kind === 'not-found')) {
        setActionError(e);
        setBusy(false);
        return;
      }
    }
    setState((s) => ({
      ...s,
      items:
        kind === 'delete'
          ? s.items.filter((d) => d.fingerprint !== doc.fingerprint)
          : s.items.map((d) =>
              d.fingerprint === doc.fingerprint
                ? { ...d, storage: { state: 'none', bytes: null, storedAt: null } }
                : d,
            ),
    }));
    setPending(null);
    setBusy(false);
    loadUsage();
    announce(kind === 'delete' ? `Deleted ${name}.` : `Removed the stored file for ${name}.`);
    listHeading.current?.focus();
    // The first page is now empty but more exist: fetch the next page instead of claiming there are none.
    if (kind === 'delete' && state.items.length === 1 && state.next) loadMore();
  };

  return (
    <section>
      <h1 ref={heading} tabIndex={-1}>
        Documents
      </h1>
      <Quota
        usage={usage}
        failure={usageFailure}
        retry={() => {
          setUsageFailure(null);
          loadUsage();
        }}
      />
      <h2 className="sr-only" tabIndex={-1} ref={listHeading}>
        Your PDFs
      </h2>

      {state.status === 'loading' ? <Loading label="Loading documents…" /> : null}
      {state.status === 'error' ? <ErrorState failure={state.failure} onRetry={onReload} /> : null}
      {state.status === 'ready' && state.items.length === 0 && !state.next ? (
        <Empty>
          <p>You have no PDFs yet.</p>
          <p className="muted">
            PDFs you open in the Clavis reader appear here with your reading progress. You can
            choose to store a copy in your account from the reader.
          </p>
        </Empty>
      ) : null}
      {state.status === 'ready' && state.items.length === 0 && state.next ? (
        state.more === 'error' ? (
          <ErrorState failure={state.moreFailure} onRetry={loadMore} />
        ) : (
          <Loading label="Loading more documents…" />
        )
      ) : null}
      {state.status === 'ready' && state.items.length > 0 ? (
        <>
          <ul className="cards" aria-label="Documents">
            {state.items.map((d) => {
              const p = progressOf(d);
              const name = d.title ?? 'Untitled PDF';
              const stored = d.storage.state === 'stored';
              return (
                <li key={d.fingerprint} className="card card--doc">
                  <div className="card__main">
                    <h3 className="card__title break">{name}</h3>
                    <p className="progress">
                      <span>{p.text}</span>
                      {p.value !== null && p.max !== null ? (
                        <progress
                          max={p.max}
                          value={p.value}
                          aria-label={`Reading progress for ${name}`}
                        />
                      ) : null}
                    </p>
                    <p className="meta">
                      <span>
                        {formatCount(d.highlightCount)} highlight{d.highlightCount === 1 ? '' : 's'}
                      </span>
                      <span>
                        {stored && d.storage.bytes !== null
                          ? `Stored in your account: ${formatBytes(d.storage.bytes)}`
                          : 'File not stored in your account'}
                      </span>
                      <span>Last read {formatDate(d.clientModifiedAt)}</span>
                    </p>
                  </div>
                  <div className="card__actions">
                    {stored ? (
                      <>
                        <a
                          className="btn btn--quiet btn--small"
                          href={fileUrl(d.fingerprint)}
                          download
                          aria-label={`Download ${name}`}
                        >
                          Download
                        </a>
                        <button
                          type="button"
                          className="btn btn--quiet btn--small"
                          aria-label={`Remove file for ${name}`}
                          onClick={() => {
                            setActionError(null);
                            setPending({ kind: 'remove-file', doc: d });
                          }}
                        >
                          Remove file
                        </button>
                      </>
                    ) : null}
                    <button
                      type="button"
                      className="btn btn--quiet btn--small"
                      aria-label={`Delete document ${name}`}
                      onClick={() => {
                        setActionError(null);
                        setPending({ kind: 'delete', doc: d });
                      }}
                    >
                      Delete document
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          {state.more === 'error' ? (
            <ErrorState failure={state.moreFailure} onRetry={loadMore} />
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

      {pending ? (
        <ConfirmDialog
          title={pending.kind === 'delete' ? 'Delete this document?' : 'Remove the stored file?'}
          confirmLabel={pending.kind === 'delete' ? 'Delete document' : 'Remove file'}
          busy={busy}
          onConfirm={() => void run()}
          onCancel={() => setPending(null)}
        >
          {pending.kind === 'delete' ? (
            <p>
              “{pending.doc.title ?? 'Untitled PDF'}”, its highlights and reading progress, and any
              stored file will be deleted from your account and your other devices. Copies on your
              own devices are not touched. This cannot be undone.
            </p>
          ) : (
            <p>
              The copy of “{pending.doc.title ?? 'Untitled PDF'}” stored in your account will be
              deleted, which frees up space. Your reading progress and highlights are kept.
            </p>
          )}
          {actionError ? (
            <p className="notice notice--danger" role="alert">
              {describeFailure(actionError)}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
