import 'pdfjs-dist/web/pdf_viewer.css';
import '../common/page.css';
import './reader.css';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { t } from '../../lib/i18n';
import { Announcer } from './Announcer';
import { FindBar } from './FindBar';
import { LinkConfirm } from './LinkConfirm';
import { PasswordPrompt } from './PasswordPrompt';
import { ReaderToolbar } from './ReaderToolbar';
import { ReaderPlayback } from './ReaderPlayback';
import { ReaderHighlights } from './ReaderHighlights';
import { StateMessage } from './StateMessage';
import { useFindBar } from './useFindBar';
import { useReaderController } from './useReaderController';
import { useReaderSelection } from './useReaderSelection';
import { useReaderShortcuts } from './useReaderShortcuts';
import { useReaderNarration } from './useReaderNarration';

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
  const findBar = useFindBar(controller, containerRef);
  const hasPages = SHOWS_PAGES.has(state.phase);
  const narration = useReaderNarration(
    controller,
    containerRef,
    openCount,
    renderCount,
    view?.pageCount ?? 0,
  );

  useReaderSelection(containerRef, renderCount, hasPages ? openCount : null);
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
    (file: File) => {
      narration.stop();
      setOpenCount((n) => n + 1);
      resetFind();
      void controller.openFile(file);
    },
    [controller, resetFind, narration],
  );

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
        </div>
        <ReaderToolbar
          key={openCount}
          controller={controller}
          view={view}
          findOpen={findBar.open}
          onToggleFind={() => (findBar.open ? findBar.hide() : findBar.show())}
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
                ) : (
                  <StateMessage state={state} dragging={dragging} onOpen={pickFile} />
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
            <div className="reader__sidebar" inert={pendingLink !== null}>
              <ReaderHighlights
                controller={controller}
                containerRef={containerRef}
                renderCount={renderCount}
                documentKey={openCount}
              />
            </div>
          ) : null}
        </div>

        <Announcer snapshot={snapshot} />
      </main>
    </div>
  );
}
