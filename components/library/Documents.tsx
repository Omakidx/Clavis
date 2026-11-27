import { useState } from 'react';
import { FEATURES } from '../../lib/config/constants';
import { countHighlightsByDocument, deleteDocument, listDocuments } from '../../lib/data/documents';
import type { LocalDocument } from '../../lib/data/db';
import { kickSync } from '../../lib/data/kick';
import { t } from '../../lib/i18n';
import { documentClient } from '../../lib/ui-client/document-client';
import { openExtensionPage, openReaderDocument } from '../../lib/ui-client/navigation';
import { useAccountStatus } from '../../lib/ui-client/use-account-status';
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

const MB = 1024 * 1024;
const megabytes = (bytes: number): string =>
  `${(bytes / MB).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;

/** The PDFs read in the reader, most recent first: where the reader stopped, highlights, remove. */
export function Documents() {
  const { state } = useLocalData(readDocuments, WATCH);
  const [removing, setRemoving] = useState<LocalDocument | null>(null);
  const [removingFile, setRemovingFile] = useState<LocalDocument | null>(null);
  const [message, setMessage] = useState('');
  // Cloud state (design 7.7) shows only in a build with accounts, signed in.
  const account = useAccountStatus();
  const cloud =
    FEATURES.accountSync && account.state.status === 'ready' && account.state.data.signedIn;

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

  const answerFile = (confirmed: boolean): void => {
    const doc = removingFile;
    setRemovingFile(null);
    if (!confirmed || doc === null) return;
    void documentClient.removeFile(doc.fingerprint).then((result) => {
      setMessage(result.ok ? t('libraryDocFileRemoved', titleOf(doc)) : result.error.message);
    });
  };
  // The server's count (reservations and the account's own quota included); no bar without it.
  const usage = account.state.status === 'ready' ? (account.state.data.usage ?? null) : null;

  return (
    <div className="library-docs">
      <p className="clavis-muted">{t('libraryDocsNote')}</p>
      <p className="clavis-muted" data-testid="library-docs-count">
        {t('libraryDocsCount', String(documents.length))}
      </p>
      {cloud && usage !== null ? (
        <div className="library-quota" data-testid="library-quota">
          <label htmlFor="library-quota-bar">{t('libraryQuotaLabel')}</label>
          <progress
            id="library-quota-bar"
            max={Math.max(usage.storageQuotaBytes, 1)}
            value={Math.min(usage.storageUsedBytes, Math.max(usage.storageQuotaBytes, 1))}
          />
          <span className="clavis-muted">
            {t('libraryQuotaUsed', [
              megabytes(usage.storageUsedBytes),
              megabytes(usage.storageQuotaBytes),
            ])}
          </span>
        </div>
      ) : null}
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
                {cloud ? (
                  <>
                    {' · '}
                    <span data-testid="library-doc-cloud" data-state={doc.storageState}>
                      {doc.storageState === 'stored'
                        ? t('libraryDocCloudStored')
                        : t('libraryDocCloudNone')}
                    </span>
                  </>
                ) : null}
              </p>
            </div>
            <div className="clavis-actions">
              <Button
                aria-label={t('libraryDocOpenLabel', titleOf(doc))}
                data-testid="library-doc-open"
                onClick={() =>
                  cloud && doc.storageState === 'stored'
                    ? openReaderDocument(doc.fingerprint)
                    : openExtensionPage('/reader.html')
                }
              >
                {cloud && doc.storageState === 'stored'
                  ? t('libraryDocOpenCloud')
                  : t('libraryDocOpen')}
              </Button>
              {cloud && doc.storageState === 'stored' ? (
                <Button
                  data-testid="library-doc-remove-file"
                  aria-label={t('libraryDocRemoveFileLabel', titleOf(doc))}
                  onClick={() => setRemovingFile(doc)}
                >
                  {t('libraryDocRemoveFile')}
                </Button>
              ) : null}
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
      {removingFile === null ? null : (
        <ConfirmDialog
          danger
          title={t('libraryDocRemoveFileTitle', titleOf(removingFile))}
          body={t('libraryDocRemoveFileBody')}
          confirmLabel={t('libraryDocRemoveFile')}
          onAnswer={answerFile}
        />
      )}
      <LiveStatus message={message} />
    </div>
  );
}
