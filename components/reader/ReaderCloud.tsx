import { useCallback, useEffect, useState } from 'react';
import { LIMITS } from '../../shared/api-contract/limits';
import { onAccountStatusChanged, onDataChanged } from '../../lib/data/channel';
import { getDocument } from '../../lib/data/documents';
import { dropHandoff, putHandoff, takeHandoff } from '../../lib/data/handoff';
import { isSignedIn } from '../../lib/data/sync-flag';
import { t } from '../../lib/i18n';
import type { PdfReaderController } from '../../lib/pdf/controller';
import { titleFromFileName } from '../../lib/pdf/state';
import { documentClient } from '../../lib/ui-client/document-client';
import { describeError } from '../../lib/ui-client/errors';

/**
 * The reader's account features (docs/clavis-sync-design.md 6.6, 7.7), loaded on demand and only
 * when `FEATURES.accountSync` is on (Reader.tsx). The reader never calls the Clavis API (rule R2):
 * a file travels through the `fileHandoff` store and the background does the network part.
 *
 * - `openFromAccount`: fetch a stored PDF for `reader.html?doc=<fingerprint>`.
 * - `CloudSave`: the "Save to account" / "Stored in account" state next to the file title.
 */

export type CloudOpen =
  { ok: true; file: File } | { ok: false; kind: 'signin' | 'error'; message: string };

const failed = (message: string): CloudOpen => ({ ok: false, kind: 'error', message });

/**
 * Download the file of document `fingerprint` through the background and return it as a File for
 * `controller.openFile` (the local-bytes pipeline is unchanged). The handoff entry is deleted
 * as soon as it is read, and on every failure path.
 */
export async function openFromAccount(fingerprint: string): Promise<CloudOpen> {
  if (!(await isSignedIn())) {
    return { ok: false, kind: 'signin', message: t('readerCloudSignInNeeded') };
  }
  const known = await getDocument(fingerprint).catch(() => undefined);
  const fetched = await documentClient.fetchFile(fingerprint);
  if (!fetched.ok) {
    // The background may have written the file before the reply was lost: never leave it behind.
    await dropHandoff(fingerprint, 'download');
    const signin = fetched.error.code === 'NOT_SIGNED_IN';
    return signin
      ? { ok: false, kind: 'signin', message: t('readerCloudSignInNeeded') }
      : failed(fetched.error.message);
  }
  let blob: Blob | null;
  try {
    blob = await takeHandoff(fingerprint, 'download');
  } catch {
    blob = null;
  }
  if (blob === null) {
    await dropHandoff(fingerprint, 'download');
    return failed(describeError('INTERNAL_ERROR').message);
  }
  if (blob.size > LIMITS.maxFileBytes) return failed(describeError('FILE_TOO_LARGE').message);
  const name = `${known?.title ?? fingerprint.slice(0, 12)}.pdf`;
  return { ok: true, file: new File([blob], name, { type: 'application/pdf' }) };
}

interface CloudSaveProps {
  controller: PdfReaderController;
  /** The file the user opened (the controller hashes before PDF.js takes the buffer, so the reader keeps it). */
  file: File | null;
  fileName: string;
  /** The reader's phase: only a shown document can be saved. */
  showing: boolean;
}

/** Whether a file of this size may be stored (design 6.6: at most 15 MiB, and not empty). */
export const canStore = (bytes: number): boolean => bytes > 0 && bytes <= LIMITS.maxFileBytes;

/**
 * "Save to account" while signed in, the document is known, the file is at most 15 MiB and the
 * account does not hold it yet; "Stored in account" once it does. Renders nothing otherwise
 * (signed out, nothing open, file too large).
 */
export function CloudSave({ controller, file, fileName, showing }: CloudSaveProps) {
  const fingerprint = showing ? controller.documentId : null;
  const [signedIn, setSignedIn] = useState(false);
  const [stored, setStored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let active = true;
    const read = (): void => {
      void isSignedIn().then((value) => {
        if (active) setSignedIn(value);
      });
    };
    read();
    const stop = onAccountStatusChanged(read);
    return () => {
      active = false;
      stop();
    };
  }, []);

  useEffect(() => {
    if (fingerprint === null) return;
    let active = true;
    const read = (): void => {
      void getDocument(fingerprint)
        .catch(() => undefined)
        .then((doc) => {
          if (active) setStored(doc?.storageState === 'stored');
        });
    };
    read();
    const stop = onDataChanged(read, ['documents']);
    return () => {
      active = false;
      stop();
    };
  }, [fingerprint]);

  const save = useCallback(async (): Promise<void> => {
    if (fingerprint === null || file === null || busy) return;
    setBusy(true);
    setError('');
    setSaved(false);
    try {
      // A download of this very file is in the store: let it finish, then try again.
      if (!(await putHandoff(fingerprint, file, 'upload'))) {
        setBusy(false);
        setError(describeError('UPLOAD_IN_PROGRESS').message);
        return;
      }
    } catch {
      setBusy(false);
      setError(describeError('INTERNAL_ERROR').message);
      return;
    }
    const result = await documentClient.upload(
      fingerprint,
      titleFromFileName(fileName) ?? fingerprint.slice(0, 12),
    );
    // The background deletes the entry in every case; if the message never arrived, this does.
    if (!result.ok) await dropHandoff(fingerprint, 'upload');
    setBusy(false);
    if (result.ok) {
      setStored(result.data.state === 'stored');
      setSaved(true);
    } else {
      setError(result.error.message);
    }
  }, [fingerprint, file, fileName, busy]);

  if (!signedIn || fingerprint === null) return null;
  const offer = file !== null && canStore(file.size);
  if (!stored && !offer) return null;

  return (
    <div className="reader-cloud" data-testid="reader-cloud">
      {stored ? (
        <span className="reader-cloud__stored" data-testid="cloud-stored">
          <svg viewBox="0 0 20 20" width="16" height="16" fill="none" aria-hidden="true">
            <path
              d="m4.5 10.5 3.5 3.5 7.5-8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t('readerCloudStored')}
        </span>
      ) : (
        <button
          type="button"
          className="clavis-button reader-cloud__save"
          data-testid="cloud-save"
          disabled={busy}
          aria-busy={busy}
          title={t('readerCloudSaveTitle')}
          onClick={() => void save()}
        >
          {busy ? t('readerCloudSaving') : t('readerCloudSave')}
        </button>
      )}
      <span className="clavis-sr-only" role="status" data-testid="cloud-status">
        {saved ? t('readerCloudSavedLive') : ''}
      </span>
      {error === '' ? null : (
        <span className="reader-cloud__error" role="alert" data-testid="cloud-error">
          {error}
        </span>
      )}
    </div>
  );
}
