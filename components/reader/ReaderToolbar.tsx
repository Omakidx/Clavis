import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { t } from '../../lib/i18n';
import type { FindStatus, PdfReaderController, ViewStatus } from '../../lib/pdf/controller';
import { FIT_WIDTH, ZOOM_PRESETS } from '../../lib/pdf/limits';

interface ReaderToolbarProps {
  controller: PdfReaderController;
  view: ViewStatus | null;
  find: FindStatus;
  onOpen: () => void;
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

function FindSummary({ find }: { find: FindStatus }) {
  if (find.state === 'not-found') return <>{t('readerFindNotFound')}</>;
  if (find.state === 'pending') return <>{t('readerFindPending')}</>;
  if (find.total > 0) {
    return <>{t('readerFindCount', [String(find.current), String(find.total)])}</>;
  }
  return null;
}

/** Rendered with a `key` that changes per opened file, so draft state never leaks between documents. */
export function ReaderToolbar({ controller, view, find, onOpen, onClose }: ReaderToolbarProps) {
  const disabled = view === null;
  const [pageDraft, setPageDraft] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const queryRef = useRef('');

  const pageCount = view?.pageCount ?? 0;

  const commitPage = (event?: FormEvent) => {
    event?.preventDefault();
    if (pageDraft !== null && pageDraft.trim() !== '') controller.goToPage(Number(pageDraft));
    setPageDraft(null);
  };

  const onQueryChange = (value: string) => {
    queryRef.current = value;
    setQuery(value);
    controller.find(value);
  };

  const onFindKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      controller.find(queryRef.current, { again: true, previous: event.shiftKey });
    } else if (event.key === 'Escape') {
      onQueryChange('');
    }
  };

  return (
    <div className="reader-toolbar" role="toolbar" aria-label={t('readerTitle')}>
      <button type="button" className="button button--primary" onClick={onOpen}>
        {t('readerOpen')}
      </button>

      <button type="button" className="button" disabled={disabled} onClick={onClose}>
        {t('readerClose')}
      </button>

      <div className="reader-toolbar__group">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => controller.previousPage()}
          aria-label={t('readerPrevPage')}
          title={t('readerPrevPage')}
        >
          ‹
        </button>
        <form className="reader-toolbar__page" onSubmit={commitPage}>
          <input
            className="reader-input reader-input--page"
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
          className="button"
          disabled={disabled}
          onClick={() => controller.nextPage()}
          aria-label={t('readerNextPage')}
          title={t('readerNextPage')}
        >
          ›
        </button>
      </div>

      <div className="reader-toolbar__group">
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => controller.zoomOut()}
          aria-label={t('readerZoomOut')}
          title={t('readerZoomOut')}
        >
          −
        </button>
        <select
          className="reader-input"
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
          className="button"
          disabled={disabled}
          onClick={() => controller.zoomIn()}
          aria-label={t('readerZoomIn')}
          title={t('readerZoomIn')}
        >
          +
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled}
          onClick={() => controller.fitWidth()}
        >
          {t('readerFitWidth')}
        </button>
      </div>

      <div className="reader-toolbar__group reader-toolbar__find">
        <input
          className="reader-input reader-input--find"
          type="search"
          disabled={disabled}
          placeholder={t('readerFindLabel')}
          aria-label={t('readerFindLabel')}
          data-testid="find-input"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onKeyDown={onFindKey}
        />
        <button
          type="button"
          className="button"
          disabled={disabled || query.trim() === ''}
          onClick={() => controller.find(query, { again: true, previous: true })}
          aria-label={t('readerFindPrev')}
          title={t('readerFindPrev')}
        >
          ↑
        </button>
        <button
          type="button"
          className="button"
          disabled={disabled || query.trim() === ''}
          onClick={() => controller.find(query, { again: true })}
          aria-label={t('readerFindNext')}
          title={t('readerFindNext')}
        >
          ↓
        </button>
        <span className="reader-toolbar__find-status" role="status" data-testid="find-status">
          <FindSummary find={find} />
        </span>
      </div>
    </div>
  );
}
