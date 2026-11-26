import { useState } from 'react';
import type { LocalWord } from '../../lib/data/db';
import { t } from '../../lib/i18n';
import { toSafeExternalUrl } from '../../lib/pdf/links';
import { Button } from '../common/ui';
import { ChatPane } from './ChatPane';
import { ConfirmDialog } from './ConfirmDialog';

interface Props {
  word: LocalWord;
  onDelete(word: LocalWord): Promise<void>;
}

type Pending = { kind: 'delete' } | { kind: 'link'; url: string } | null;

/** The date a word was saved, in the reader's own locale. */
const dateOf = (ms: number): string =>
  new Date(ms).toLocaleDateString(undefined, { dateStyle: 'medium' });

/**
 * One saved word: the meaning that was saved, where it was read, the chat about it and delete.
 * Everything is a text node (D-10): model output, page titles and addresses are never markup.
 */
export function WordDetail({ word, onDelete }: Props) {
  const [pending, setPending] = useState<Pending>(null);
  const { meaning, source } = word;
  const safeUrl =
    source.kind === 'webpage' && source.url !== null ? toSafeExternalUrl(source.url) : null;

  const answer = (confirmed: boolean): void => {
    const current = pending;
    setPending(null);
    if (!confirmed || current === null) return;
    if (current.kind === 'delete') void onDelete(word);
    else window.open(current.url, '_blank', 'noopener,noreferrer');
  };

  return (
    <article
      className="library-word"
      aria-labelledby="library-word-title"
      data-testid="library-detail"
    >
      <header className="library-word__head">
        <h2 id="library-word-title" tabIndex={-1} dir="auto">
          {word.text}
        </h2>
        <Button
          variant="danger"
          data-testid="library-delete"
          onClick={() => setPending({ kind: 'delete' })}
        >
          {t('libraryDeleteWord')}
        </Button>
      </header>
      <p className="clavis-muted">{t('librarySavedOn', dateOf(word.createdAt))}</p>

      <section aria-labelledby="library-meaning-title">
        <h3 id="library-meaning-title">{t('libraryMeaningTitle')}</h3>
        <p dir="auto">
          <strong>{meaning.title}</strong>
        </p>
        <p dir="auto">{meaning.summary}</p>
        {meaning.contextualMeaning === undefined ? null : (
          <>
            <h4>{t('libraryInContext')}</h4>
            <p dir="auto">{meaning.contextualMeaning}</p>
          </>
        )}
        {meaning.definition === undefined ? null : (
          <>
            <h4>{t('libraryDefinition')}</h4>
            <p dir="auto">{meaning.definition}</p>
          </>
        )}
        {meaning.examples === undefined || meaning.examples.length === 0 ? null : (
          <>
            <h4>{t('libraryExamples')}</h4>
            <ul>
              {meaning.examples.map((example, index) => (
                <li key={`${index}:${example.sentence}`} dir="auto">
                  {example.sentence}
                  {example.note === undefined ? null : (
                    <span className="clavis-muted"> {example.note}</span>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {meaning.caveat === undefined ? null : (
          <>
            <h4>{t('libraryCaveat')}</h4>
            <p dir="auto">{meaning.caveat}</p>
          </>
        )}
        <p className="clavis-muted">{t('libraryModel', meaning.model)}</p>
      </section>

      {word.contextBefore === undefined && word.contextAfter === undefined ? null : (
        <section aria-labelledby="library-context-title">
          <h3 id="library-context-title">{t('libraryContextTitle')}</h3>
          <blockquote className="library-context" dir="auto">
            {word.contextBefore}
            <mark>{word.text}</mark>
            {word.contextAfter}
          </blockquote>
        </section>
      )}

      <section aria-labelledby="library-source-title" data-testid="library-source">
        <h3 id="library-source-title">{t('librarySourceTitle')}</h3>
        {source.kind === 'pdf' ? (
          <p dir="auto">
            {source.title === null
              ? t('librarySourcePdfPage', String(source.page))
              : t('librarySourcePdf', [source.title, String(source.page)])}
          </p>
        ) : (
          <>
            <p dir="auto">{source.title ?? source.url ?? t('librarySourceUnknown')}</p>
            {source.title !== null && source.url !== null ? (
              <p className="clavis-muted library-url" dir="ltr">
                {source.url}
              </p>
            ) : null}
            {safeUrl === null ? null : (
              <Button
                data-testid="library-open-source"
                onClick={() => setPending({ kind: 'link', url: safeUrl.href })}
              >
                {t('librarySourceOpen')}
                <span className="clavis-sr-only"> {t('uiOpensInNewTab')}</span>
              </Button>
            )}
          </>
        )}
      </section>

      <ChatPane wordKey={word.wordKey} word={word.text} />

      {pending === null ? null : pending.kind === 'delete' ? (
        <ConfirmDialog
          danger
          title={t('libraryDeleteWordTitle', word.text)}
          body={t('libraryDeleteWordBody')}
          confirmLabel={t('libraryDeleteConfirm')}
          onAnswer={answer}
        />
      ) : (
        <ConfirmDialog
          title={t('readerLinkConfirmTitle')}
          body={t('readerLinkConfirmBody', pending.url)}
          confirmLabel={t('readerLinkOpen')}
          onAnswer={answer}
        />
      )}
    </article>
  );
}
