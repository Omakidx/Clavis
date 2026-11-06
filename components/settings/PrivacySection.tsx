import { useEffect, useId, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { api } from '../../lib/ui-client/api';
import type { ClientError } from '../../lib/ui-client/errors';
import { CLAVIS_PRIVACY_POLICY_URL } from '../../lib/ui-client/links';
import { Button, ErrorNotice, ExternalLink, LiveStatus, Notice } from '../common/ui';
import { SettingsIcon } from '../common/Icons';
import { useToast } from '../common/Toast';
import { DisclosureList } from './DisclosureList';

interface PrivacySectionProps {
  /** Called after the background cleared everything, so the page can reload what it shows. */
  onCleared(): void;
}

/** Settings: what is sent and when, the key-storage caveat (FR-071) and Clear all data (FR-078). */
export function PrivacySection({ onCleared }: PrivacySectionProps) {
  const toast = useToast();
  const headingId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<ClientError | null>(null);

  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
  }, [confirming]);

  async function clear() {
    setBusy(true);
    setError(null);
    const result = await api.clearAllData();
    setBusy(false);
    setConfirming(false);
    if (result.ok) {
      setDone(true);
      toast?.show({ content: t('clearDone'), tone: 'success' });
      onCleared();
      headingRef.current?.focus();
    } else {
      setError(result.error);
      toast?.show({
        content: <ErrorNotice error={result.error} onRetry={() => setConfirming(true)} />,
        tone: 'danger',
      });
    }
  }

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-privacy">
      <h2 id={headingId} tabIndex={-1} ref={headingRef}>
        <SettingsIcon name="privacy" />
        {t('privacyTitle')}
      </h2>
      <p>{t('privacyIntro')}</p>
      <DisclosureList />
      <Notice tone="warning">
        <p>{t('keyNotEncrypted')}</p>
      </Notice>
      <p>
        <ExternalLink href={CLAVIS_PRIVACY_POLICY_URL}>{t('privacyPolicyLink')}</ExternalLink>
      </p>

      <h3>{t('clearTitle')}</h3>
      <p>{t('clearBody')}</p>
      {confirming ? (
        <div
          className="clavis-notice clavis-notice--danger"
          role="alertdialog"
          aria-busy={busy}
          aria-labelledby={`${headingId}-confirm`}
          aria-describedby={`${headingId}-confirm-body`}
        >
          <h3 id={`${headingId}-confirm`}>{t('clearConfirmTitle')}</h3>
          <p id={`${headingId}-confirm-body`}>{t('clearConfirmBody')}</p>
          <div className="clavis-actions">
            <Button variant="danger" disabled={busy} onClick={() => void clear()}>
              {t('clearConfirm')}
            </Button>
            <Button ref={cancelRef} onClick={() => setConfirming(false)}>
              {t('uiCancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="clavis-actions">
          <Button
            onClick={() => {
              setDone(false);
              setConfirming(true);
            }}
          >
            {t('clearButton')}
          </Button>
        </div>
      )}
      {!toast ? <LiveStatus message={done ? t('clearDone') : null} tone="success" /> : null}
      {!toast && error ? <ErrorNotice error={error} onRetry={() => setConfirming(true)} /> : null}
    </section>
  );
}
