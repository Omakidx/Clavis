import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { onAccountStatusChanged, onDataChanged, onDataCleared } from '../../lib/data/channel';
import { FEATURES } from '../../lib/config/constants';
import { isSignedIn } from '../../lib/data/sync-flag';
import { getDocument, listDocuments, saveProgress } from '../../lib/data/documents';
import { kickSync } from '../../lib/data/kick';
import type { LocalDocument } from '../../lib/data/db';
import { t } from '../../lib/i18n';
import type {
  PdfReaderController,
  ReaderSnapshot,
  ReadingPosition,
} from '../../lib/pdf/controller';
import { titleFromFileName } from '../../lib/pdf/state';

/**
 * The reader's use of the local data layer (docs/clavis-sync-design.md 7.3): reading progress and
 * the "Continue reading" list. Loaded on demand (React.lazy in Reader.tsx) so opening the reader
 * does not pay for IndexedDB code before a document is shown. The full reader redesign (S-08) is a
 * later phase; this is deliberately minimal.
 */

/** Saves are debounced this long after the last page change or scroll (design 7.3). */
export const PROGRESS_DEBOUNCE_MS = 2000;
/** Largest file size a document record keeps (the shared record limit, 100 MiB). */
const MAX_RECORDED_BYTES = 104_857_600;
const CONTINUE_LIST_SIZE = 8;

/** Set when Clear all data ran: this page never writes progress again (L-1). */
let dataCleared = false;
/** For tests only. */
export const resetClearedForTests = (): void => {
  dataCleared = false;
};

interface ResumeProps {
  controller: PdfReaderController;
  containerRef: RefObject<HTMLElement | null>;
  snapshot: ReaderSnapshot;
  /** Changes with every file the user opens, so a reopened file restores again. */
  documentKey: number;
}

const PAGES_ON_SCREEN = new Set(['ready', 'image-only']);

/**
 * Records where the reader is (debounced 2 s after a page change or scroll, at once when the tab is
 * hidden or closed) and, when a file with a known position opens, returns to it with a "Back to
 * start" action. Renders only that note.
 */
export function ReaderResume({ controller, containerRef, snapshot, documentKey }: ResumeProps) {
  // The page the reader returned to, for the file opened as `key` (a new file shows no note).
  const [resumed, setResumed] = useState<{ key: number; page: number } | null>(null);
  const phase = snapshot.state.phase;
  const showing = PAGES_ON_SCREEN.has(phase);
  const fileName = snapshot.fileName;
  const pageCount = snapshot.view?.pageCount ?? null;
  const page = snapshot.view?.page ?? null;
  const save = useRef<() => void>(() => undefined);
  const schedule = useRef<() => void>(() => undefined);

  useEffect(() => {
    const container = containerRef.current;
    const fingerprint = controller.documentId;
    if (!showing || !container || !fingerprint) return;
    let active = true;
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last: ReadingPosition | null = null;
    const bytes = controller.fileBytes;
    const fileBytes = bytes > 0 && bytes <= MAX_RECORDED_BYTES ? bytes : null;

    const flush = (): void => {
      clearTimeout(timer);
      timer = undefined;
      if (!armed || dataCleared) return;
      // The controller forgets the document when it is closed or replaced: use the last known place.
      const position = controller.getPosition() ?? last;
      if (position === null) return;
      last = position;
      void saveProgress(fingerprint, {
        title: titleFromFileName(fileName),
        pageCount,
        fileBytes,
        lastPage: position.page,
        pageOffset: position.pageOffset,
      }).then(
        (wrote) => (wrote ? kickSync() : undefined),
        () => undefined,
      );
    };
    const later = (): void => {
      if (!armed) return;
      last = controller.getPosition() ?? last;
      clearTimeout(timer);
      timer = setTimeout(flush, PROGRESS_DEBOUNCE_MS);
    };
    save.current = flush;
    schedule.current = later;

    // Opening a document pulls other devices' progress (design 4.7); a no-op signed out.
    void kickSync(true);
    void getDocument(fingerprint)
      .catch(() => undefined)
      .then((known) => {
        if (!active) return;
        if (known?.lastPage != null && known.lastPage > 1) {
          const restored = controller.restorePosition({
            page: known.lastPage,
            pageOffset: known.pageOffset ?? 0,
          });
          if (restored) setResumed({ key: documentKey, page: known.lastPage });
        }
        armed = true;
        // A file read for the first time gets its record (title, pages) at once.
        last = controller.getPosition();
        flush();
      });

    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };
    const stopCleared = onDataCleared(() => {
      dataCleared = true;
      armed = false;
      clearTimeout(timer);
    });
    container.addEventListener('scroll', later, { passive: true });
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', flush);
    return () => {
      active = false;
      stopCleared();
      container.removeEventListener('scroll', later);
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', flush);
      flush();
      save.current = () => undefined;
      schedule.current = () => undefined;
    };
    // The record's title and page count are read once per opened file; later renders re-schedule below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controller, containerRef, showing, documentKey]);

  // A page change (keyboard, toolbar, find) counts like a scroll.
  useEffect(() => schedule.current(), [page]);

  const backToStart = useCallback(() => {
    controller.restorePosition({ page: 1, pageOffset: 0 });
    setResumed(null);
  }, [controller]);

  if (resumed === null || resumed.key !== documentKey || !showing) return null;
  return (
    <div className="reader-banner reader-resume" role="status" data-testid="reader-resumed">
      <span>{t('readerResumed', String(resumed.page))}</span>
      <button type="button" className="clavis-button" onClick={backToStart}>
        {t('readerBackToStart')}
      </button>
      <button type="button" className="clavis-button" onClick={() => setResumed(null)}>
        {t('readerResumedDismiss')}
      </button>
    </div>
  );
}

/**
 * Recently read PDFs, in the reader's empty state, as cards with a progress bar. A PDF stored in
 * the account (signed in, accounts on) opens straight from `?doc=<fingerprint>`; the others ask
 * for the file again and return to the saved place when its fingerprint matches (design 7.7).
 */
export function ContinueReading({ onOpen }: { onOpen(): void }) {
  const [documents, setDocuments] = useState<LocalDocument[]>([]);
  const [account, setAccount] = useState(false);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      void listDocuments(CONTINUE_LIST_SIZE * 3)
        .then((all) => {
          if (active) {
            setDocuments(all.filter((doc) => doc.lastPage !== null).slice(0, CONTINUE_LIST_SIZE));
          }
        })
        .catch(() => undefined);
    };
    read();
    // Signed in, a pull can bring cards that other devices read, and their stored state.
    const stop = FEATURES.accountSync ? onDataChanged(read, ['documents']) : () => undefined;
    // Signing in or out changes which cards may open from the account.
    const readAccount = (): void => {
      void isSignedIn().then((value) => {
        if (active) setAccount(value);
      });
    };
    let stopAccount = (): void => undefined;
    if (FEATURES.accountSync) {
      readAccount();
      stopAccount = onAccountStatusChanged(readAccount);
    }
    return () => {
      active = false;
      stop();
      stopAccount();
    };
  }, []);
  if (documents.length === 0) return null;
  const fromAccount = (doc: LocalDocument): boolean => account && doc.storageState === 'stored';
  return (
    <section
      className="reader-continue"
      aria-labelledby="reader-continue-title"
      data-testid="reader-continue"
    >
      <h3 id="reader-continue-title">{t('readerContinueTitle')}</h3>
      {documents.every(fromAccount) ? null : (
        <p className="clavis-muted">{t('readerContinueHint')}</p>
      )}
      <ul className="reader-continue__list">
        {documents.map((doc) => {
          const title = doc.title ?? t('libraryDocUntitled');
          const page = doc.lastPage ?? 1;
          const progress =
            doc.pageCount === null
              ? t('readerContinuePage', String(page))
              : t('readerContinueItem', [String(page), String(doc.pageCount)]);
          return (
            <li key={doc.fingerprint} className="reader-card" data-testid="reader-continue-item">
              <span className="reader-card__title" dir="auto" title={title}>
                {title}
              </span>
              <span className="reader-card__meta">
                {progress}
                {fromAccount(doc) ? (
                  <span className="reader-card__badge">{t('readerContinueStored')}</span>
                ) : null}
              </span>
              {doc.pageCount === null ? null : (
                <progress
                  className="reader-card__bar"
                  max={doc.pageCount}
                  value={Math.min(page, doc.pageCount)}
                  aria-label={t('readerContinueProgressLabel', title)}
                  aria-valuetext={progress}
                />
              )}
              {fromAccount(doc) ? (
                <a
                  className="clavis-button clavis-button--primary reader-card__action"
                  href={`?doc=${doc.fingerprint}`}
                  aria-label={t('readerContinueFromAccountLabel', title)}
                  data-testid="reader-continue-cloud"
                >
                  {t('readerContinueFromAccount')}
                </a>
              ) : (
                <button
                  type="button"
                  className="clavis-button reader-card__action"
                  aria-label={t('readerContinueOpenLabel', title)}
                  onClick={onOpen}
                >
                  {t('readerContinueOpen')}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
