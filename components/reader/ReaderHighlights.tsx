import { useEffect, useRef, useState, type RefObject } from 'react';
import { browser } from 'wxt/browser';
import type { PdfReaderController } from '../../lib/pdf/controller';
import {
  createHighlightStore,
  HIGHLIGHT_COLORS,
  parseHighlightDocuments,
  type HighlightColor,
  type ReaderHighlight,
} from '../../lib/pdf/highlights';
import {
  captureReaderTextSelection,
  readerTextRange,
  type ReaderTextSelection,
} from '../../lib/pdf/reader-text';
import { STORAGE_KEYS } from '../../lib/storage/keys';
import { t, type MessageKey } from '../../lib/i18n';
import './highlights.css';
import { useReaderTextVersion } from './useReaderTextVersion';

interface Props {
  controller: PdfReaderController;
  containerRef: RefObject<HTMLDivElement | null>;
  renderCount: number;
  documentKey: number;
}

const colorLabels: Record<HighlightColor, MessageKey> = {
  yellow: 'readerHighlightYellow',
  green: 'readerHighlightGreen',
  blue: 'readerHighlightBlue',
  pink: 'readerHighlightPink',
};

/** Local annotations never modify the PDF or its text layer. Only offsets and colors are saved. */
export function ReaderHighlights({ controller, containerRef, renderCount, documentKey }: Props) {
  const [store] = useState(() => createHighlightStore(browser.storage.local));
  const [marks, setMarks] = useState<ReaderHighlight[]>([]);
  const [selection, setSelection] = useState<ReaderTextSelection[]>([]);
  const [error, setError] = useState<MessageKey | null>(null);
  const [status, setStatus] = useState<MessageKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(
    () =>
      typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 49rem)').matches,
  );
  const generation = useRef(0);
  const pendingNavigation = useRef<ReaderHighlight | null>(null);
  const [paintVersion, setPaintVersion] = useState(0);
  const documentId = controller.documentId;
  const textVersion = useReaderTextVersion(containerRef);
  const count = selection.reduce((total, range) => total + range.end - range.start, 0);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia('(min-width: 49rem)');
    const resize = () => setExpanded(query.matches);
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, []);

  useEffect(() => {
    let active = true;
    let revision = 0;
    const turn = ++generation.current;
    if (documentId) {
      void store
        .list(documentId)
        .then((saved) => {
          if (active && turn === generation.current && revision === 0) setMarks(saved);
        })
        .catch(() => {
          if (active) setError('readerHighlightsLoadError');
        });
    }
    const changed: Parameters<typeof browser.storage.onChanged.addListener>[0] = (
      changes,
      area,
    ) => {
      if (!active || area !== 'local' || !(STORAGE_KEYS.readerHighlights in changes)) return;
      const documents = parseHighlightDocuments(changes[STORAGE_KEYS.readerHighlights]?.newValue);
      revision++;
      setMarks(documentId ? (documents[documentId] ?? []) : []);
    };
    browser.storage.onChanged.addListener(changed);
    return () => {
      active = false;
      generation.current = turn + 1;
      pendingNavigation.current = null;
      browser.storage.onChanged.removeListener(changed);
    };
  }, [documentId, documentKey, store]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let sequence = 0;
    const capture = () => {
      const turn = ++sequence;
      void captureReaderTextSelection(container, (page) => controller.readPageText(page))
        .then((ranges) => {
          if (turn === sequence) setSelection(ranges);
        })
        .catch(() => {
          if (turn === sequence) setSelection([]);
        });
    };
    container.ownerDocument.addEventListener('selectionchange', capture);
    return () => {
      sequence++;
      container.ownerDocument.removeEventListener('selectionchange', capture);
    };
  }, [controller, containerRef, documentKey]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof Highlight === 'undefined' || !globalThis.CSS?.highlights) return;
    let active = true;
    const groups = new Map<HighlightColor, Range[]>(HIGHLIGHT_COLORS.map((color) => [color, []]));
    const paint = async () => {
      const visible = new Set(
        Array.from(
          container.querySelectorAll<HTMLElement>('.page[data-page-number] .textLayer'),
        ).map((layer) => Number(layer.closest<HTMLElement>('.page')?.dataset['pageNumber'])),
      );
      const models = new Map(
        await Promise.all(
          Array.from(visible, async (page) => [page, await controller.readPageText(page)] as const),
        ),
      );
      if (!active) return;
      for (const mark of marks) {
        const model = models.get(mark.page);
        if (!model || mark.end > model.text.length) continue;
        const range = readerTextRange(container, model, mark.start, mark.end);
        if (range) groups.get(mark.color)?.push(range);
      }
      for (const [color, ranges] of groups)
        CSS.highlights.set(`clavis-pdf-mark-${color}`, new Highlight(...ranges));
      const pending = pendingNavigation.current;
      const model = pending ? models.get(pending.page) : null;
      if (pending && model) {
        const range = readerTextRange(container, model, pending.start, pending.end);
        if (range) {
          range.startContainer.parentElement?.scrollIntoView({
            block: 'center',
            behavior: 'instant',
          });
          pendingNavigation.current = null;
        }
      }
    };
    void paint().catch(() => {
      /* A closing PDF invalidates its worker before React unmounts. */
    });
    return () => {
      active = false;
      for (const color of HIGHLIGHT_COLORS) CSS.highlights.delete(`clavis-pdf-mark-${color}`);
    };
  }, [containerRef, controller, marks, renderCount, paintVersion, textVersion]);

  const mutate = async (task: (id: string) => Promise<ReaderHighlight[]>, saved = false) => {
    if (!documentId || busy) return;
    const turn = generation.current;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      const next = await task(documentId);
      if (turn !== generation.current) return;
      setMarks(next);
      if (saved) setStatus('readerHighlightsSaved');
    } catch (reason) {
      if (turn === generation.current)
        setError(
          reason instanceof Error && reason.message === 'highlight-limit'
            ? 'readerHighlightsLimit'
            : 'readerHighlightsError',
        );
    } finally {
      if (turn === generation.current) setBusy(false);
    }
  };

  const add = (color: HighlightColor) => {
    if (!selection.length) return;
    const next = selection.map((range) => ({
      ...range,
      id: crypto.randomUUID(),
      color,
      createdAt: Date.now(),
    }));
    void mutate((id) => store.add(id, next), true);
  };

  const navigate = (mark: ReaderHighlight) => {
    pendingNavigation.current = mark;
    controller.goToPage(mark.page);
    setPaintVersion((version) => version + 1);
  };

  return (
    <aside className="reader-highlights" aria-label={t('readerHighlightsTitle')}>
      <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}>
        <summary>
          <span>{t('readerHighlightsTitle')}</span>
          <span className="reader-highlights__count">
            {t('readerHighlightsCount', String(marks.length))}
          </span>
        </summary>
        <div className="reader-highlights__body">
          <p className="reader-highlights__hint">{t('readerHighlightsHint')}</p>
          <div
            className="reader-highlights__palette"
            role="group"
            aria-label={t('readerHighlightsTitle')}
          >
            {HIGHLIGHT_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`reader-swatch reader-swatch--${color}`}
                aria-label={t(colorLabels[color])}
                title={t(colorLabels[color])}
                disabled={!documentId || selection.length === 0 || busy}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => add(color)}
              >
                <span aria-hidden="true" />
              </button>
            ))}
          </div>
          {count ? (
            <p className="reader-highlights__hint">
              {t('readerHighlightsSelection', String(count))}
            </p>
          ) : null}
          {!documentId ? <p role="status">{t('readerHighlightsUnavailable')}</p> : null}
          {marks.length ? (
            <ol className="reader-highlights__list">
              {marks.map((mark) => (
                <li key={mark.id}>
                  <button
                    type="button"
                    className="reader-highlights__location"
                    onClick={() => void navigate(mark)}
                    title={t('readerHighlightLocation', [
                      String(mark.page),
                      String(mark.start + 1),
                      String(mark.end),
                    ])}
                  >
                    <span
                      className={`reader-mark-dot reader-mark-dot--${mark.color}`}
                      aria-hidden="true"
                    />
                    <span>
                      {t('readerHighlightPage', String(mark.page))}
                      <small>
                        {mark.start + 1}–{mark.end}
                      </small>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="reader-highlights__remove"
                    disabled={busy}
                    aria-label={t('readerHighlightRemove', String(mark.page))}
                    onClick={() => void mutate((id) => store.remove(id, mark.id))}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      aria-hidden="true"
                    >
                      <path d="m7 7 10 10M17 7 7 17" strokeLinecap="round" />
                    </svg>
                  </button>
                </li>
              ))}
            </ol>
          ) : (
            <p className="reader-highlights__empty">{t('readerHighlightsEmpty')}</p>
          )}
          {marks.length ? (
            <button
              type="button"
              className="clavis-button reader-highlights__clear"
              disabled={busy}
              onClick={() =>
                void mutate(async (id) => {
                  await store.clear(id);
                  return [];
                })
              }
            >
              {t('readerHighlightsClear')}
            </button>
          ) : null}
          <p className="reader-highlights__local">{t('readerHighlightsLocal')}</p>
          <div role="status" className="reader-highlights__status">
            {status ? t(status) : ''}
          </div>
          {error ? (
            <p role="alert" className="reader-highlights__error">
              {t(error)}
            </p>
          ) : null}
        </div>
      </details>
    </aside>
  );
}
