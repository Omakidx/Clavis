import { useId, useMemo, useRef, useState } from 'react';
import { listAllChat } from '../../lib/data/chat';
import type { LocalWord } from '../../lib/data/db';
import { kickSync } from '../../lib/data/kick';
import { deleteWord, listWords } from '../../lib/data/words';
import { t } from '../../lib/i18n';
import { Button, LiveStatus, Notice } from '../common/ui';
import { buildWordsExport, downloadJson } from './export';
import { useLocalData } from './data';
import { WordDetail } from './WordDetail';

/** Words whose text, title or summary contains the query (case-insensitive). */
export function filterWords(words: readonly LocalWord[], query: string): LocalWord[] {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === '') return [...words];
  return words.filter((word) =>
    [word.text, word.meaning.title, word.meaning.summary].some((field) =>
      field.toLocaleLowerCase().includes(needle),
    ),
  );
}

const WATCH = ['words'] as const;

export function SavedWords() {
  const { state } = useLocalData(listWords, WATCH);
  const [query, setQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const searchId = useId();
  const search = useRef<HTMLInputElement>(null);

  const words = useMemo(() => (state.status === 'ready' ? state.data : []), [state]);
  const shown = useMemo(() => filterWords(words, query), [words, query]);
  const selected = words.find((word) => word.wordKey === selectedKey) ?? null;

  if (state.status === 'loading') {
    return (
      <p className="clavis-muted" data-testid="library-loading">
        {t('libraryLoading')}
      </p>
    );
  }
  if (state.status === 'error') {
    return (
      <div role="alert" className="clavis-notice clavis-notice--danger" data-testid="library-error">
        <p>{t('libraryLoadError')}</p>
      </div>
    );
  }
  if (words.length === 0) {
    return (
      <section className="library-empty" data-testid="library-words-empty">
        <h2>{t('libraryWordsEmptyTitle')}</h2>
        <p>{t('libraryWordsEmptyBody')}</p>
      </section>
    );
  }

  const exportJson = (): void => {
    void (async () => {
      try {
        const chat = await listAllChat();
        downloadJson(buildWordsExport(words, chat, Date.now()), 'clavis-saved-words.json');
        setMessage(t('libraryExportDone', [String(words.length), String(chat.length)]));
      } catch {
        setMessage(t('libraryExportFailed'));
      }
    })();
  };

  const remove = async (word: LocalWord): Promise<void> => {
    try {
      await deleteWord(word.wordKey);
      void kickSync();
      setSelectedKey(null);
      setMessage(t('libraryWordDeleted', word.text));
      // The word the focus was on is gone: keep keyboard users in the page.
      search.current?.focus();
    } catch {
      setMessage(t('libraryDeleteFailed'));
    }
  };

  return (
    <div className="library-words">
      <div className="library-toolbar">
        <div className="clavis-field library-search">
          <label className="clavis-label" htmlFor={searchId}>
            {t('libraryWordsSearchLabel')}
          </label>
          <input
            ref={search}
            id={searchId}
            type="search"
            className="clavis-input"
            value={query}
            autoComplete="off"
            data-testid="library-search"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <p className="clavis-muted library-count" data-testid="library-count">
          {t('libraryWordsCount', String(shown.length))}
        </p>
        <Button data-testid="library-export" onClick={exportJson}>
          {t('libraryExport')}
        </Button>
      </div>

      <div className="library-split">
        <nav aria-label={t('libraryWordsListLabel')} className="library-list-wrap">
          {shown.length === 0 ? (
            <Notice testId="library-no-match">
              <p>{t('libraryWordsNoMatch', query.trim())}</p>
            </Notice>
          ) : (
            <ul className="library-list" data-testid="library-list">
              {shown.map((word) => (
                <li key={word.wordKey}>
                  <button
                    type="button"
                    className="library-item"
                    aria-current={word.wordKey === selectedKey ? 'true' : undefined}
                    data-testid="library-item"
                    onClick={() => setSelectedKey(word.wordKey)}
                  >
                    <span className="library-item__text" dir="auto">
                      {word.text}
                    </span>
                    <span className="library-item__summary clavis-muted" dir="auto">
                      {word.meaning.summary}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <section className="library-detail" aria-live="off">
          {selected === null ? (
            <p className="clavis-muted" data-testid="library-select-hint">
              {t('libraryWordsSelect')}
            </p>
          ) : (
            <WordDetail key={selected.wordKey} word={selected} onDelete={remove} />
          )}
        </section>
      </div>
      <LiveStatus message={message} />
    </div>
  );
}
