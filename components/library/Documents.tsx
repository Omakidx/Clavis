import { useState } from 'react';
import { countHighlightsByDocument, deleteDocument, listDocuments } from '../../lib/data/documents';
import type { LocalDocument } from '../../lib/data/db';
import { kickSync } from '../../lib/data/kick';
import { t } from '../../lib/i18n';
import { openExtensionPage } from '../../lib/ui-client/navigation';
import { Button, LiveStatus } from '../common/ui';
import { ConfirmDialog } from './ConfirmDialog';
import { useLocalData } from './data';

const WATCH = ['documents', 'highlights'] as const;

async function readDocuments(): Promise<{
  documents: LocalDocument[];
  marks: Map<string, number>;
}> {
  const [documents, marks] = await Promise.all([listDocuments(), countHighlightsByDocument()]);
  return { documents, marks };
}

const titleOf = (doc: LocalDocument): string => doc.title ?? t('libraryDocUntitled');

/** Where the reader stopped, as a sentence; documents with marks only say so. */
function progressText(doc: LocalDocument): string {
  if (doc.lastPage === null) return t('libraryDocNoProgress');
  return doc.pageCount === null
    ? t('libraryDocProgressPage', String(doc.lastPage))
    : t('libraryDocProgress', [String(doc.lastPage), String(doc.pageCount)]);
}

/** The PDFs read in the reader, most recent first: where the reader stopped, highlights, remove. */
export function Documents() {
  const { state } = useLocalData(readDocuments, WATCH);
  const [removing, setRemoving] = useState<LocalDocument | null>(null);
  const [message, setMessage] = useState('');

  if (state.status === 'loading') return <p className="clavis-muted">{t('libraryLoading')}</p>;
  if (state.status === 'error') {
    return (
      <div role="alert" className="clavis-notice clavis-notice--danger">
        <p>{t('libraryLoadError')}</p>
      </div>
    );
  }
  const { documents, marks } = state.data;
  if (documents.length === 0) {
    return (
      <section className="library-empty" data-testid="library-docs-empty">
        <h2>{t('libraryDocsEmptyTitle')}</h2>
        <p>{t('libraryDocsEmptyBody')}</p>
      </section>
    );
  }

  const answer = (confirmed: boolean): void => {
    const doc = removing;
    setRemoving(null);
    if (!confirmed || doc === null) return;
    void deleteDocument(doc.fingerprint).then(
      () => {
        void kickSync();
        setMessage(t('libraryDocDeleted', titleOf(doc)));
      },
      () => setMessage(t('libraryDeleteFailed')),
    );
  };

  return (
    <div className="library-docs">
      <p className="clavis-muted">{t('libraryDocsNote')}</p>
      <p className="clavis-muted" data-testid="library-docs-count">
        {t('libraryDocsCount', String(documents.length))}
      </p>
      <ul
        className="library-doclist"
        aria-label={t('libraryDocsListLabel')}
        data-testid="library-doclist"
      >
        {documents.map((doc) => (
          <li key={doc.fingerprint} className="library-doc" data-testid="library-doc">
            <div className="library-doc__main">
              <h2 className="library-doc__title" dir="auto">
                {titleOf(doc)}
              </h2>
              <p className="clavis-muted">
                {progressText(doc)} ·{' '}
                {t('libraryDocHighlights', String(marks.get(doc.fingerprint) ?? 0))} ·{' '}
                {t(
                  'libraryDocLastRead',
                  new Date(doc.clientModifiedAt).toLocaleDateString(undefined, {
                    dateStyle: 'medium',
                  }),
                )}
              </p>
            </div>
            <div className="clavis-actions">
              <Button
                aria-label={t('libraryDocOpenLabel', titleOf(doc))}
                onClick={() => openExtensionPage('/reader.html')}
              >
                {t('libraryDocOpen')}
              </Button>
              <Button
                variant="danger"
                data-testid="library-doc-delete"
                aria-label={t('libraryDocDeleteLabel', titleOf(doc))}
                onClick={() => setRemoving(doc)}
              >
                {t('libraryDocDelete')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {removing === null ? null : (
        <ConfirmDialog
          danger
          title={t('libraryDocDeleteTitle', titleOf(removing))}
          body={t('libraryDocDeleteBody')}
          confirmLabel={t('libraryDeleteConfirm')}
          onAnswer={answer}
        />
      )}
      <LiveStatus message={message} />
    </div>
  );
}
