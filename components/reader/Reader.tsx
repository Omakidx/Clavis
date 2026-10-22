import 'pdfjs-dist/web/pdf_viewer.css';
import '../common/page.css';
import './reader.css';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { t } from '../../lib/i18n';
import { LinkConfirm } from './LinkConfirm';
import { PasswordPrompt } from './PasswordPrompt';
import { ReaderToolbar } from './ReaderToolbar';
import { SelectionPanel } from './SelectionPanel';
import { StateMessage } from './StateMessage';
import { useReaderController } from './useReaderController';
import { useSelectionSnapshot } from './useSelectionSnapshot';

/** Phases in which pages are on screen (the others show a message over the stage instead). */
const SHOWS_PAGES = new Set(['ready', 'image-only']);

/**
 * React shell around the PDF.js viewer components (D-06): open/drop, toolbar, state messages.
 * The viewer container is always laid out (PDF.js measures it for fit-width); messages are
 * overlays, never replacements.
 */
export function Reader() {
  const { controller, snapshot, containerRef, viewerRef, pendingLink, answerLink } =
    useReaderController();
  const { state, view, find, renderCount } = snapshot;
  const fileInput = useRef<HTMLInputElement>(null);
  const [openCount, setOpenCount] = useState(0);
  const [dragging, setDragging] = useState(false);
  const { last } = useSelectionSnapshot(containerRef);

  useEffect(() => {
    document.title = t('readerTitle');
  }, []);

  const openFile = useCallback(
    (file: File) => {
      setOpenCount((n) => n + 1);
      void controller.openFile(file);
    },
    [controller],
  );

  const onPick = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // picking the same file again must fire `change`
    if (file) openFile(file);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) openFile(file);
  };

  const onDragOver = (event: DragEvent) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragging(true);
  };

  const overlay = !SHOWS_PAGES.has(state.phase);

  return (
    <div
      className="reader"
      onDragOver={onDragOver}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      data-phase={state.phase}
      data-dragging={dragging}
      data-render-count={renderCount}
    >
      <header className="reader__header">
        <h1 className="reader__title">{t('readerTitle')}</h1>
        <ReaderToolbar
          key={openCount}
          controller={controller}
          view={view}
          find={find}
          onOpen={() => fileInput.current?.click()}
          onClose={() => void controller.close()}
        />
        <input
          ref={fileInput}
          type="file"
          accept="application/pdf,.pdf"
          hidden
          data-testid="file-input"
          onChange={onPick}
        />
      </header>

      {state.phase === 'image-only' ? <StateMessage state={state} dragging={false} /> : null}

      <div className="reader__stage">
        <div
          ref={containerRef}
          className="reader__viewer-container"
          role="region"
          aria-label={t('readerViewerLabel')}
          tabIndex={0}
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
              <StateMessage state={state} dragging={dragging} />
            )}
          </div>
        ) : null}

        {pendingLink ? (
          <div className="reader__overlay reader__overlay--modal">
            <LinkConfirm url={pendingLink.url} onAnswer={answerLink} />
          </div>
        ) : null}
      </div>

      <SelectionPanel selection={last} />
    </div>
  );
}
