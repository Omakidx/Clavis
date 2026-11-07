import { useState, type FormEvent } from 'react';
import { t } from '../../lib/i18n';
import type { ReaderNarration, NarrationScope } from './useReaderNarration';

interface ReaderPlaybackProps {
  narration: ReaderNarration;
  pageCount: number;
  currentPage: number;
  blocked: boolean;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
      <path d="M5 2.8a1 1 0 0 1 1.53-.85l10 7.2a1 1 0 0 1 0 1.7l-10 7.2A1 1 0 0 1 5 17.2V2.8Z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 20 20" width="15" height="15" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3" width="4" height="14" rx="1" />
      <rect x="12" y="3" width="4" height="14" rx="1" />
    </svg>
  );
}

export function ReaderPlayback({
  narration,
  pageCount,
  currentPage,
  blocked,
}: ReaderPlaybackProps) {
  const [scope, setScope] = useState<NarrationScope>('whole');
  const [from, setFrom] = useState(String(currentPage));
  const [to, setTo] = useState(String(pageCount));
  const active = narration.status === 'playing' || narration.status === 'preparing';
  const canStart =
    narration.status === 'idle' || narration.status === 'complete' || narration.status === 'error';
  const statusText =
    narration.status === 'preparing'
      ? t('readerListenStatusPreparing')
      : narration.status === 'playing'
        ? t('readerListenStatusPlaying', [String(narration.page), String(pageCount)])
        : narration.status === 'paused'
          ? t('readerListenStatusPaused', String(narration.page))
          : narration.status === 'complete'
            ? t('readerListenStatusComplete')
            : narration.status === 'error'
              ? t('readerListenStatusError')
              : t('readerListenStatusIdle');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (canStart) void narration.start(scope, Number(from), Number(to));
  };

  return (
    <section
      className="reader-playback"
      aria-label={t('readerListenTitle')}
      inert={blocked}
      data-testid="reader-playback"
    >
      <div className="reader-playback__intro">
        <div>
          <h2>{t('readerListenTitle')}</h2>
          <p>{t('readerListenSubtitle')}</p>
        </div>
        <span className="reader-playback__status" role="status" aria-live="polite">
          {statusText}
        </span>
      </div>
      <form className="reader-playback__controls" onSubmit={submit}>
        <label className="reader-playback__field">
          <span className="clavis-sr-only">{t('readerListenWhole')}</span>
          <select
            className="clavis-select reader-playback__scope"
            aria-label={t('readerListenTitle')}
            value={scope}
            disabled={!canStart}
            onChange={(event) => setScope(event.target.value as NarrationScope)}
            data-testid="reader-listen-scope"
          >
            <option value="whole">{t('readerListenWhole')}</option>
            <option value="selection">{t('readerListenSelection')}</option>
            <option value="range">{t('readerListenRange')}</option>
          </select>
        </label>
        {scope === 'range' && canStart ? (
          <div className="reader-playback__range">
            <label>
              {t('readerListenFrom')}
              <input
                className="clavis-input"
                type="number"
                min={1}
                max={pageCount}
                value={from}
                onChange={(event) => setFrom(event.target.value)}
              />
            </label>
            <label>
              {t('readerListenTo')}
              <input
                className="clavis-input"
                type="number"
                min={1}
                max={pageCount}
                value={to}
                onChange={(event) => setTo(event.target.value)}
              />
            </label>
          </div>
        ) : null}
        {canStart ? (
          <button
            className="clavis-button clavis-button--primary reader-playback__play"
            type="submit"
            data-testid="reader-listen-play"
          >
            <PlayIcon /> {t('readerListenPlay')}
          </button>
        ) : active ? (
          <button
            className="clavis-button reader-playback__play"
            type="button"
            onClick={narration.pause}
            data-testid="reader-listen-pause"
          >
            <PauseIcon /> {t('readerListenPause')}
          </button>
        ) : (
          <button
            className="clavis-button clavis-button--primary reader-playback__play"
            type="button"
            onClick={narration.resume}
            data-testid="reader-listen-resume"
          >
            <PlayIcon /> {t('readerListenResume')}
          </button>
        )}
        {!canStart ? (
          <button
            className="clavis-button reader-playback__stop"
            type="button"
            onClick={narration.stop}
            data-testid="reader-listen-stop"
          >
            {t('readerListenStop')}
          </button>
        ) : null}
        <label className="reader-playback__speed">
          {t('readerListenSpeed')}
          <select
            className="clavis-select"
            aria-label={t('readerListenSpeed')}
            value={String(narration.rate)}
            onChange={(event) => narration.setRate(Number(event.target.value))}
            data-testid="reader-listen-speed"
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((speed) => (
              <option value={speed} key={speed}>
                {speed}×
              </option>
            ))}
          </select>
        </label>
        <label className="reader-playback__follow" title={t('readerListenFollowHint')}>
          <input
            type="checkbox"
            checked={narration.follow}
            onChange={(event) => narration.setFollow(event.target.checked)}
          />
          <span>{t('readerListenFollow')}</span>
        </label>
      </form>
      {narration.error ? (
        <p className="reader-playback__error" role="alert">
          {narration.error}
        </p>
      ) : null}
      {narration.timingUnavailable && (active || narration.status === 'paused') ? (
        <p className="reader-playback__hint">{t('readerListenTimingUnavailable')}</p>
      ) : null}
    </section>
  );
}
