import { t } from '../../lib/i18n';
import type { ListenReport } from '../../lib/selection/ui-api';
import { Button } from '../common/ui';

interface Props {
  report: ListenReport;
  /** The user's Slow choice (undefined = the saved preference). */
  slowChoice: boolean | undefined;
  onStart(): void;
  onStop(): void;
  onToggleSlow(): void;
  onVoiceSettings(): void;
}

/** What the playback state says, in words (also announced by the panel's live region). */
export function listenMessage(report: ListenReport): string {
  switch (report.status) {
    case 'starting':
      return t('speechStarting');
    case 'playing':
      return t('speechPlaying');
    case 'ended':
      return report.message === undefined ? t('listenDone') : t(report.message);
    case 'failed':
    case 'unavailable':
      return report.hint === undefined
        ? t(report.message)
        : `${t(report.message)} ${t(report.hint)}`;
    case 'idle':
      return '';
  }
}

/**
 * Listen / Stop / Replay and the Slow toggle for the panel's selected text. Same states as the
 * toolbar, taken from the same controller.
 */
export function ListenBar({
  report,
  slowChoice,
  onStart,
  onStop,
  onToggleSlow,
  onVoiceSettings,
}: Props) {
  const busy = report.status === 'starting' || report.status === 'playing';
  const slow = slowChoice ?? (report.status === 'playing' ? report.slow : false);
  const message = listenMessage(report);
  return (
    <div className="sp-listen" role="group" aria-label={t('panelListenGroup')}>
      <div className="clavis-actions">
        {busy ? (
          <Button data-testid="panel-stop" onClick={onStop}>
            {t('speechStop')}
          </Button>
        ) : (
          <Button variant="primary" data-testid="panel-listen" onClick={onStart}>
            {report.status === 'ended' ? t('speechReplay') : t('toolbarListen')}
          </Button>
        )}
        <Button data-testid="panel-slow" aria-pressed={slow} onClick={onToggleSlow}>
          {t('speechSlow')}
        </Button>
      </div>
      {message === '' ? null : (
        <p className="clavis-hint" data-testid="panel-listen-status">
          {message}
        </p>
      )}
      {report.status === 'playing' && report.remote ? (
        <p className="clavis-hint">{t('speechRemoteNote')}</p>
      ) : null}
      {report.status === 'unavailable' ? (
        <div className="clavis-actions">
          <Button onClick={onVoiceSettings}>{t('speechVoiceSettings')}</Button>
        </div>
      ) : null}
    </div>
  );
}
