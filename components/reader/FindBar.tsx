import type { KeyboardEvent, Ref } from 'react';
import { t } from '../../lib/i18n';
import { summarizeFind, type FindStatus } from '../../lib/pdf/find';

interface FindBarProps {
  query: string;
  caseSensitive: boolean;
  find: FindStatus;
  inputRef: Ref<HTMLInputElement>;
  barRef: Ref<HTMLDivElement>;
  onQuery: (value: string) => void;
  onToggleCase: () => void;
  /** Step to the next (or, with `previous`, the previous) match. */
  onStep: (previous: boolean) => void;
  onClose: () => void;
}

function summaryText(find: FindStatus, query: string): string {
  const summary = summarizeFind(find, query);
  switch (summary.kind) {
    case 'not-found':
      return t('readerFindNotFound');
    case 'pending':
      return t('readerFindPending');
    case 'count':
      return t('readerFindCount', [String(summary.current), String(summary.total)]);
    case 'none':
      return '';
  }
}

/**
 * Find in document (FR-057, Should). Enter and Shift+Enter step through matches, Escape closes
 * the bar (handled with the other shortcuts in useReaderShortcuts, and here for the input itself).
 */
export function FindBar({
  query,
  caseSensitive,
  find,
  inputRef,
  barRef,
  onQuery,
  onToggleCase,
  onStep,
  onClose,
}: FindBarProps) {
  const blank = query.trim() === '';

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      onStep(event.shiftKey);
    }
  };

  return (
    <div
      ref={barRef}
      id="reader-find-bar"
      className="reader-find"
      role="search"
      aria-label={t('readerFindLabel')}
      data-testid="find-bar"
    >
      <input
        ref={inputRef}
        className="clavis-input reader-input reader-input--find"
        type="search"
        placeholder={t('readerFindLabel')}
        aria-label={t('readerFindLabel')}
        autoComplete="off"
        spellCheck={false}
        dir="auto"
        data-testid="find-input"
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className="clavis-button reader-icon-button"
        disabled={blank}
        onClick={() => onStep(true)}
        aria-label={t('readerFindPrev')}
        title={t('readerFindPrev')}
        data-testid="find-prev"
      >
        <span aria-hidden="true">↑</span>
      </button>
      <button
        type="button"
        className="clavis-button reader-icon-button"
        disabled={blank}
        onClick={() => onStep(false)}
        aria-label={t('readerFindNext')}
        title={t('readerFindNext')}
        data-testid="find-next"
      >
        <span aria-hidden="true">↓</span>
      </button>
      <button
        type="button"
        className="clavis-button reader-toggle"
        aria-pressed={caseSensitive}
        onClick={onToggleCase}
        data-testid="find-case"
      >
        {t('readerFindCase')}
      </button>
      <span className="reader-find__status" role="status" data-testid="find-status">
        {summaryText(find, query)}
      </span>
      <button
        type="button"
        className="clavis-button"
        onClick={() => onClose()}
        data-testid="find-close"
      >
        {t('readerFindClose')}
      </button>
    </div>
  );
}
