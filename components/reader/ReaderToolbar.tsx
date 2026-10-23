import { useState, type FormEvent, type Ref } from 'react';
import { t } from '../../lib/i18n';
import type { PdfReaderController, ViewStatus } from '../../lib/pdf/controller';
import { FIT_WIDTH, ZOOM_PRESETS } from '../../lib/pdf/limits';

interface ReaderToolbarProps {
  controller: PdfReaderController;
  view: ViewStatus | null;
  findOpen: boolean;
  onToggleFind: () => void;
  onOpen: () => void;
  /** Ref of the Open PDF button, so the shell can return focus to it. */
  openRef?: Ref<HTMLButtonElement>;
  onClose: () => void;
}

const percent = (scale: number): string => t('readerZoomPercent', String(Math.round(scale * 100)));

/** Value of the zoom drop-down for the current scale: a preset, fit-width, or `custom`. */
function zoomValue(view: ViewStatus | null): string {
  if (!view) return FIT_WIDTH;
  if (view.scaleValue === FIT_WIDTH) return FIT_WIDTH;
  const preset = ZOOM_PRESETS.find((p) => Math.abs(p - view.zoom) < 0.005);
  return preset === undefined ? 'custom' : String(preset);
}

/**
 * Open/close, page navigation, zoom and the find toggle. Rendered with a `key` that changes per
 * opened file, so the page-number draft never leaks between documents. Everything is a native
 * control in DOM order (no roving tabindex): Tab visits them in the order they read.
 */
export function ReaderToolbar({
  controller,
  view,
  findOpen,
  onToggleFind,
  onOpen,
  openRef,
  onClose,
}: ReaderToolbarProps) {
  const disabled = view === null;
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const pageCount = view?.pageCount ?? 0;

  const commitPage = (event?: FormEvent) => {
    event?.preventDefault();
    if (pageDraft !== null && pageDraft.trim() !== '') controller.goToPage(Number(pageDraft));
    setPageDraft(null);
  };

  return (
    <div className="reader-toolbar">
      <div className="reader-toolbar__group">
        <button
          ref={openRef}
          type="button"
          className="clavis-button clavis-button--primary"
          onClick={onOpen}
        >
          {t('readerOpen')}
        </button>
        <button type="button" className="clavis-button" disabled={disabled} onClick={onClose}>
          {t('readerClose')}
        </button>
      </div>

      <div className="reader-toolbar__group" role="group" aria-label={t('readerGroupPages')}>
        <button
          type="button"
          className="clavis-button reader-icon-button"
          disabled={disabled}
          onClick={() => controller.previousPage()}
          aria-label={t('readerPrevPage')}
          title={t('readerPrevPage')}
        >
          <span aria-hidden="true">‹</span>
        </button>
        <form className="reader-toolbar__page" onSubmit={commitPage} noValidate>
          <input
            className="clavis-input reader-input reader-input--page"
            type="number"
            inputMode="numeric"
            min={1}
            max={Math.max(pageCount, 1)}
            disabled={disabled}
            aria-label={t('readerPageLabel')}
            data-testid="page-input"
            value={pageDraft ?? String(view?.page ?? '')}
            onChange={(e) => setPageDraft(e.target.value)}
            onBlur={() => commitPage()}
          />
          <span data-testid="page-count">{view ? t('readerPageOf', String(pageCount)) : ''}</span>
        </form>
        <button
          type="button"
          className="clavis-button reader-icon-button"
          disabled={disabled}
          onClick={() => controller.nextPage()}
          aria-label={t('readerNextPage')}
          title={t('readerNextPage')}
        >
          <span aria-hidden="true">›</span>
        </button>
      </div>

      <div className="reader-toolbar__group" role="group" aria-label={t('readerGroupZoom')}>
        <button
          type="button"
          className="clavis-button reader-icon-button"
          disabled={disabled}
          onClick={() => controller.zoomOut()}
          aria-label={t('readerZoomOut')}
          title={t('readerZoomOut')}
        >
          <span aria-hidden="true">−</span>
        </button>
        <select
          className="clavis-select reader-input reader-input--zoom"
          disabled={disabled}
          aria-label={t('readerZoomLabel')}
          data-testid="zoom-select"
          value={zoomValue(view)}
          onChange={(e) => {
            const value = e.target.value;
            if (value === FIT_WIDTH) controller.fitWidth();
            else if (value !== 'custom') controller.setZoom(Number(value));
          }}
        >
          <option value={FIT_WIDTH}>{t('readerFitWidth')}</option>
          {ZOOM_PRESETS.map((preset) => (
            <option key={preset} value={String(preset)}>
              {percent(preset)}
            </option>
          ))}
          {zoomValue(view) === 'custom' && view ? (
            <option value="custom">{percent(view.zoom)}</option>
          ) : null}
        </select>
        <button
          type="button"
          className="clavis-button reader-icon-button"
          disabled={disabled}
          onClick={() => controller.zoomIn()}
          aria-label={t('readerZoomIn')}
          title={t('readerZoomIn')}
        >
          <span aria-hidden="true">+</span>
        </button>
        <button
          type="button"
          className="clavis-button"
          disabled={disabled}
          onClick={() => controller.fitWidth()}
          data-testid="fit-width"
        >
          {t('readerFitWidth')}
        </button>
      </div>

      <div className="reader-toolbar__group">
        <button
          type="button"
          className="clavis-button reader-toggle"
          disabled={disabled}
          aria-pressed={findOpen}
          aria-controls={findOpen ? 'reader-find-bar' : undefined}
          aria-keyshortcuts="Control+F Meta+F"
          onClick={onToggleFind}
          data-testid="find-toggle"
        >
          {t('readerFindToggle')}
        </button>
      </div>
    </div>
  );
}
