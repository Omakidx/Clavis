import 'pdfjs-dist/web/pdf_viewer.css';
import '../common/page.css';
import './reader.css';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
} from 'react';
import { FEATURES } from '../../lib/config/constants';
import { t } from '../../lib/i18n';
import { titleFromFileName } from '../../lib/pdf/state';
import { Announcer } from './Announcer';
import { FindBar } from './FindBar';
import { LinkConfirm } from './LinkConfirm';
import { PasswordPrompt } from './PasswordPrompt';
import { ReaderToolbar } from './ReaderToolbar';
import { ReaderPlayback } from './ReaderPlayback';
import { StateMessage } from './StateMessage';
import { useFindBar } from './useFindBar';
import { useReaderController } from './useReaderController';
import { useReaderSelection } from './useReaderSelection';
import { useReaderShortcuts } from './useReaderShortcuts';
import { useReaderNarration } from './useReaderNarration';

// Highlights, reading progress and the "Continue reading" list use the local data layer
// (IndexedDB). They load on demand so opening the reader does not pay for them up front.
const ReaderHighlights = lazy(() =>
  import('./ReaderHighlights').then((m) => ({ default: m.ReaderHighlights })),
);
const ReaderResume = lazy(() => import('./ReaderData').then((m) => ({ default: m.ReaderResume })));
const ContinueReading = lazy(() =>
  import('./ReaderData').then((m) => ({ default: m.ContinueReading })),
);
// Account features (design 6.6, 7.7): fetched only when the build has accounts switched on.
const CloudSave = lazy(() => import('./ReaderCloud').then((m) => ({ default: m.CloudSave })));

/** The `?doc=<fingerprint>` parameter that opens a PDF stored in the account (64 lowercase hex chars). */
export type DocParam = { kind: 'none' } | { kind: 'invalid' } | { kind: 'ok'; fingerprint: string };

export function readDocParam(search: string = window.location.search): DocParam {
  const raw = new URLSearchParams(search).get('doc');
  if (raw === null) return { kind: 'none' };
  return /^[0-9a-f]{64}$/.test(raw) ? { kind: 'ok', fingerprint: raw } : { kind: 'invalid' };
}

/** What the empty stage says while a PDF is fetched from the account, or why that did not work. */
type CloudNotice = { kind: 'fetching' } | { kind: 'signin' | 'error'; message: string };

/** Phases in which pages are on screen (the others show a message over the stage instead). */
const SHOWS_PAGES = new Set(['ready', 'image-only']);

/**
 * React shell around the PDF.js viewer components (D-06): open/drop, toolbar, find bar, state
 * messages and the shared selection toolbar. The viewer container is always laid out (PDF.js
 * measures it for fit-width); messages are overlays, never replacements.
 *
 * DOM hooks the E2E suites rely on (keep stable): `.reader[data-phase][data-render-count]`,
 * `data-testid` file-input, viewer-container, page-input, page-count, zoom-select, find-bar,
 * find-input, find-status, state-empty|loading|error|image-only, password-prompt, link-confirm.
 */
export function Reader() {
  const { controller, snapshot, containerRef, viewerRef, pendingLink, answerLink } =
    useReaderController();
  const {
    state,
    view,
    find,
    renderCount,
    pageErrors,
    annotationsLimited,
    fileName: name,
  } = snapshot;
  const fileInput = useRef<HTMLInputElement>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const [openCount, setOpenCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  // The file the user opened: the controller hashes the bytes before PDF.js takes the buffer, so
  // the reader keeps the File for "Save to account" (design 6.6).
  const [openedFile, setOpenedFile] = useState<File | null>(null);
  const [highlightsOpen, setHighlightsOpen] = useState(true);
  const [docParam] = useState(() => readDocParam());
  const [cloud, setCloud] = useState<CloudNotice | null>(
    FEATURES.accountSync && docParam.kind === 'ok' ? { kind: 'fetching' } : null,
  );
  /** The fingerprint a document opened from the account must have once the controller has hashed it. */
  const expected = useRef<string | null>(null);
  /** Counts opened files, to tell a download that finished late from one that is still current. */
  const openCountRef = useRef(0);
  const findBar = useFindBar(controller, containerRef);
  const hasPages = SHOWS_PAGES.has(state.phase);
  const narration = useReaderNarration(
    controller,
    containerRef,
    openCount,
    renderCount,
    view?.pageCount ?? 0,
  );

  // The PDF a saved word came from: read when the word is saved, so it is always the open file.
  const pdfRef = useCallback(
    () => ({
      fingerprint: controller.documentId,
      title: titleFromFileName(controller.getSnapshot().fileName),
    }),
    [controller],
  );
  useReaderSelection(containerRef, renderCount, hasPages ? openCount : null, pdfRef);
  useReaderShortcuts({
    controller,
    containerRef,
    find: findBar,
    enabled: hasPages && pendingLink === null,
  });

  useEffect(() => {
    document.title = name === '' ? t('readerTitle') : t('readerDocTitle', name);
  }, [name]);

  // Hand keyboard focus to the pages once a document has opened, so arrow keys, Space and
  // PageUp/PageDown work at once. Not while the user is somewhere that needs focus (a dialog).
  const phase = state.phase;
  useEffect(() => {
    if (phase !== 'ready') return;
    const active = document.activeElement;
    if (active === null || active === document.body || active.tagName === 'BUTTON') {
      containerRef.current?.focus({ preventScroll: true });
    }
  }, [phase, containerRef, openCount]);

  const { reset: resetFind } = findBar;
  const openFile = useCallback(
    (file: File, fromAccount?: string) => {
      narration.stop();
      // A file the user opens replaces any download still being checked; only a file that came from
      // the account is verified against its link (design 6.6).
      expected.current = fromAccount ?? null;
      openCountRef.current += 1;
      setOpenCount((n) => n + 1);
      setOpenedFile(file);
      setCloud(null);
      resetFind();
      void controller.openFile(file);
    },
    [controller, resetFind, narration],
  );

  // `?doc=<fingerprint>`: open a PDF stored in the account (design 6.6). Ignored when the build has
  // no accounts. The background downloads it into the handoff store; nothing here calls the API.
  const openRef = useRef(openFile);
  useEffect(() => {
    openRef.current = openFile;
  }, [openFile]);
  useEffect(() => {
    if (!FEATURES.accountSync || docParam.kind !== 'ok') return;
    let active = true;
    const startedAt = openCountRef.current;
    void import('./ReaderCloud')
      .then((m) => m.openFromAccount(docParam.fingerprint))
      .then((result) => {
        // The user opened a file meanwhile: it stays, and the late download is dropped.
        if (!active || openCountRef.current !== startedAt) return;
        if (!result.ok) return setCloud({ kind: result.kind, message: result.message });
        openRef.current(result.file, docParam.fingerprint);
      })
      .catch(
        () =>
          active &&
          openCountRef.current === startedAt &&
          setCloud({ kind: 'error', message: t('errGeneric') }),
      );
    return () => {
      active = false;
    };
  }, [docParam]);

  // The file from the account must be the document the link named: check once it is hashed.
  useEffect(() => {
    const want = expected.current;
    if (want === null) return;
    if (phase === 'error') expected.current = null;
    if (phase !== 'ready' && phase !== 'image-only') return;
    expected.current = null;
    if (controller.documentId !== want) {
      void controller.close();
      setCloud({ kind: 'error', message: t('errFingerprintMismatch') });
    }
  }, [phase, controller]);

  const pickFile = useCallback(() => fileInput.current?.click(), []);

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // picking the same file again must fire `change`
    if (file) openFile(file);
  };

  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');

  const onDragOver = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const onDragLeave = (event: DragEvent) => {
    // Moving between children also fires dragleave; only leaving the page counts.
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setDragging(false);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  };

  const closeFile = () => {
    narration.stop();
    resetFind();
    setOpenedFile(null);
    void controller.close();
    // The Close button is about to be disabled: keep keyboard focus somewhere useful.
    openButton.current?.focus();
  };

  const overlay = !hasPages;

  return (
    <div
      className="reader"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      data-phase={state.phase}
      data-dragging={dragging}
      data-render-count={renderCount}
    >
      <header className="reader__header" inert={pendingLink !== null}>
        <div className="reader__heading">
          <h1 className="reader__title">
            <span>{t('readerTitle')}</span>
          </h1>
          {name === '' ? null : (
            <span className="reader__file" title={name} dir="auto" data-testid="file-name">
              {name}
            </span>
          )}
          {FEATURES.accountSync ? (
            <Suspense fallback={null}>
              <CloudSave
                key={openCount}
                controller={controller}
                file={openedFile}
                fileName={name}
                showing={hasPages}
              />
            </Suspense>
          ) : null}
        </div>
        <ReaderToolbar
          key={openCount}
          controller={controller}
          view={view}
          findOpen={findBar.open}
          onToggleFind={() => (findBar.open ? findBar.hide() : findBar.show())}
          highlightsOpen={highlightsOpen}
          onToggleHighlights={() => setHighlightsOpen((open) => !open)}
          onOpen={pickFile}
          openRef={openButton}
          onClose={closeFile}
        />
        {findBar.open && hasPages ? (
          <FindBar
            query={findBar.query}
            caseSensitive={findBar.caseSensitive}
            find={find}
            inputRef={findBar.inputRef}
            barRef={findBar.barRef}
            onQuery={findBar.changeQuery}
            onToggleCase={findBar.toggleCase}
            onStep={findBar.step}
            onClose={findBar.hide}
          />
        ) : null}
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="file-input"
          onChange={onPick}
        />
      </header>

      <main className="reader__main">
        {hasPages && view ? (
          <ReaderPlayback
            narration={narration}
            pageCount={view.pageCount}
            currentPage={view.page}
            blocked={pendingLink !== null}
          />
        ) : null}
        {hasPages ? (
          <Suspense fallback={null}>
            <ReaderResume
              controller={controller}
              containerRef={containerRef}
              snapshot={snapshot}
              documentKey={openCount}
            />
          </Suspense>
        ) : null}
        {state.phase === 'image-only' ? <StateMessage state={state} dragging={false} /> : null}
        {pageErrors > 0 ? (
          <p
            className="reader-banner reader-banner--error"
            role="alert"
            data-testid="state-render-issue"
          >
            {t('readerRenderIssue')}
          </p>
        ) : null}

        {annotationsLimited ? (
          <p className="reader-banner" role="status" data-testid="state-annotations-limited">
            {t('readerAnnotationsLimited')}
          </p>
        ) : null}

        <div className="reader__workspace">
          <div className="reader__stage">
            <div
              ref={containerRef}
              className="reader__viewer-container"
              role="region"
              aria-label={t('readerViewerLabel')}
              tabIndex={0}
              inert={pendingLink !== null || overlay}
              data-testid="viewer-container"
            >
              <div ref={viewerRef} className="pdfViewer" />
            </div>

            {overlay ? (
              <div className="reader__overlay">
                {state.phase === 'password-required' ? (
                  <PasswordPrompt
                    key={`${openCount}-${state.incorrect ? 'again' : 'first'}`}
                    fileName={state.name}
                    incorrect={state.incorrect === true}
                    onSubmit={(password) => controller.submitPassword(password)}
                    onCancel={() => controller.cancelPassword()}
                  />
                ) : cloud !== null && state.phase === 'empty' ? (
                  <CloudMessage notice={cloud} onOpen={pickFile} />
                ) : (
                  <StateMessage
                    state={state}
                    dragging={dragging}
                    onOpen={pickFile}
                    extra={
                      <Suspense fallback={null}>
                        <ContinueReading onOpen={pickFile} />
                      </Suspense>
                    }
                  />
                )}
              </div>
            ) : null}

            {pendingLink ? (
              <div className="reader__overlay reader__overlay--modal">
                <LinkConfirm url={pendingLink.url} onAnswer={answerLink} />
              </div>
            ) : null}

            {dragging ? (
              <div className="reader__drop" aria-hidden="true" data-testid="drop-target">
                <p>{t('readerDropActive')}</p>
              </div>
            ) : null}
          </div>
          {hasPages ? (
            <div
              id="reader-sidebar"
              className="reader__sidebar"
              hidden={!highlightsOpen}
              inert={pendingLink !== null || !highlightsOpen}
            >
              <Suspense fallback={null}>
                <ReaderHighlights
                  controller={controller}
                  containerRef={containerRef}
                  renderCount={renderCount}
                  documentKey={openCount}
                />
              </Suspense>
            </div>
          ) : null}
        </div>

        <Announcer snapshot={snapshot} />
      </main>
    </div>
  );
}

/** The empty stage while a PDF is fetched from the account, or when that failed. */
function CloudMessage({ notice, onOpen }: { notice: CloudNotice; onOpen: () => void }) {
  if (notice.kind === 'fetching') {
    return (
      <div className="reader-message" role="status" data-testid="state-cloud">
        <p>{t('readerCloudFetching')}</p>
        <progress className="reader-progress" aria-label={t('readerCloudFetching')} />
      </div>
    );
  }
  return (
    <div
      className="reader-message reader-message--error"
      role="alert"
      data-testid="state-cloud"
      data-kind={notice.kind}
    >
      <p>{t('readerCloudOpenFailed')}</p>
      <p>{notice.message}</p>
      <div className="clavis-actions reader-empty__actions">
        <button type="button" className="clavis-button" onClick={onOpen}>
          {t('readerEmptyChoose')}
        </button>
      </div>
    </div>
  );
}
