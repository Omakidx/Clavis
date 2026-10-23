import { useEffect, useState } from 'react';
import type { ExplainMode } from '../../lib/contracts';
import { t } from '../../lib/i18n';
import { Button } from '../common/ui';
import { resultBlocks, tabLabel } from '../explanation/model';
import { settingsSectionFor, type Entry, type ExplainSession } from '../explanation/session';
import type { SettingsSection } from '../explanation/backend';
import { ResultBlocks } from './ResultBlocks';

interface SectionProps {
  mode: ExplainMode;
  entry: Entry | undefined;
  session: ExplainSession;
  now(): number;
  online: boolean;
  onCopy(mode: ExplainMode): void;
  onSettings(section: SettingsSection | undefined): void;
}

/** Errors that mean "could not reach Groq" (worded differently when the browser knows it is offline). */
const CONNECTION_CODES: readonly string[] = ['NETWORK_ERROR', 'TIMEOUT', 'NO_RESPONSE'];

/**
 * One part of the explanation as a landmark section with its own heading, so a screen-reader user
 * can jump between parts by heading and a keyboard user by the section links. Loaded parts show
 * the result; a part nobody asked for yet shows a "Load" button (D-05: nothing is prefetched);
 * failures show the same actions as the card.
 */
export function SectionView({
  mode,
  entry,
  session,
  now,
  online,
  onCopy,
  onSettings,
}: SectionProps) {
  const label = tabLabel(mode);
  const status = entry?.status ?? 'idle';
  return (
    <section
      id={`sp-section-${mode}`}
      className="sp-section"
      aria-labelledby={`sp-heading-${mode}`}
      data-testid="panel-section"
      data-mode={mode}
      data-status={status}
    >
      <div className="sp-section__head">
        <h2 id={`sp-heading-${mode}`} tabIndex={-1} className="sp-section__title">
          {label}
        </h2>
        {entry?.status === 'ready' ? (
          <Button
            className="sp-small"
            aria-label={t('panelCopySection', label)}
            data-testid="panel-copy-section"
            onClick={() => onCopy(mode)}
          >
            {t('cardCopy')}
          </Button>
        ) : null}
      </div>
      <Body
        mode={mode}
        entry={entry}
        session={session}
        now={now}
        online={online}
        onSettings={onSettings}
      />
    </section>
  );
}

function Body({ mode, entry, session, now, online, onSettings }: Omit<SectionProps, 'onCopy'>) {
  const label = tabLabel(mode);
  if (entry === undefined) {
    return (
      <div className="sp-idle">
        <p className="clavis-muted">{t('panelNotLoaded')}</p>
        <Button data-testid="panel-load" onClick={() => session.selectTab(mode)}>
          {t('panelLoadMode', label)}
        </Button>
      </div>
    );
  }
  if (entry.status === 'queued' || entry.status === 'loading') {
    return (
      <p className="sp-loading" data-testid="panel-loading">
        <span className="sp-spinner" aria-hidden="true" />
        {mode === 'core' ? t('cardLoading') : t('cardLoadingTab', label)}
      </p>
    );
  }
  if (entry.status === 'disclosure') {
    // The one-time confirmation is a decision only the card collects (no new disclosure path).
    return (
      <div className="clavis-notice clavis-notice--warning" data-testid="panel-disclosure">
        <p>{t('panelDisclosure')}</p>
        <div className="clavis-actions">
          <Button onClick={() => session.retry(mode)}>{t('uiRetry')}</Button>
        </div>
      </div>
    );
  }
  if (entry.status === 'error' && entry.error !== null) {
    const { error } = entry;
    const offline = !online && CONNECTION_CODES.includes(error.code);
    return (
      <div
        className={`clavis-notice${error.quiet === true ? '' : ' clavis-notice--danger'}`}
        data-testid="panel-error"
        data-code={error.code}
        data-offline={offline ? 'true' : undefined}
      >
        {offline ? (
          <p className="sp-error-title">{t('cardErrOfflineTitle')}</p>
        ) : error.title === null ? null : (
          <p className="sp-error-title">{error.title}</p>
        )}
        <p>{offline ? t('errOffline') : error.message}</p>
        <div className="clavis-actions">
          {error.action === 'retry' ? (
            <RetryButton error={error} mode={mode} session={session} now={now} />
          ) : error.action === 'none' ? null : (
            <Button
              variant="primary"
              data-testid="panel-settings"
              onClick={() => onSettings(settingsSectionFor(error.action))}
            >
              {error.action === 'connect'
                ? t('cardActionConnect')
                : error.action === 'update-key'
                  ? t('cardActionUpdateKey')
                  : error.action === 'choose-model'
                    ? t('cardActionChooseModel')
                    : t('uiOpenSettings')}
            </Button>
          )}
        </div>
      </div>
    );
  }
  return entry.result === null ? null : <ResultBlocks blocks={resultBlocks(entry.result)} />;
}

/** "Try again": never automatic; during a rate-limit delay it stays reachable but inactive and counts down. */
function RetryButton({
  error,
  mode,
  session,
  now,
}: {
  error: NonNullable<Entry['error']>;
  mode: ExplainMode;
  session: ExplainSession;
  now(): number;
}) {
  const remaining = (): number =>
    error.retryAt === undefined ? 0 : Math.max(0, Math.ceil((error.retryAt - now()) / 1000));
  // A once-a-second tick re-renders the countdown; the number itself is read from the clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (remaining() === 0) return;
    const timer = setInterval(() => {
      setTick((tick) => tick + 1);
      if (remaining() === 0) {
        clearInterval(timer);
        session.announce(t('cardRetryReady'));
      }
    }, 1000);
    return () => clearInterval(timer);
    // `remaining` only reads `error` and the clock.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);
  const seconds = remaining();
  const waiting = seconds > 0;
  return (
    <Button
      variant="primary"
      data-testid="panel-retry"
      aria-disabled={waiting ? 'true' : undefined}
      onClick={() => {
        if (!waiting) session.retry(mode);
      }}
    >
      {waiting
        ? t('cardRetryWait', String(seconds))
        : error.quiet === true
          ? t('cardLoadAgain')
          : t('uiRetry')}
    </Button>
  );
}
