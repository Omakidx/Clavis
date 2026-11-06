/** @jsxImportSource preact */
import { useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { ListenReport } from '../../lib/selection/ui-api';
import { isTrustedEvent } from '../../lib/selection/trust';
import { t } from '../../lib/i18n';
import type { CardHost } from './ExplanationCard';

/** Pronunciation uses the toolbar's existing speech controller and background-owned voice choice. */
export function TranslationSpeech({
  text,
  lang,
  host,
}: {
  text: string;
  lang: string | undefined;
  host: CardHost;
}) {
  const [report, setReport] = useState<ListenReport>({ status: 'idle' });
  const stopRef = useRef<(() => void) | null>(null);
  const reportRef = useRef<(next: ListenReport) => void>(() => undefined);
  const busy = report.status === 'starting' || report.status === 'playing';

  useLayoutEffect(() => {
    let current = true;
    const update = (next: ListenReport): void => {
      if (current) setReport(next);
    };
    // Keep the callback lifetime separate from a late speech-start reply after the view is gone.
    reportRef.current = update;
    return () => {
      current = false;
      stopRef.current?.();
      stopRef.current = null;
    };
  }, [text, lang, host]);

  const message =
    report.status === 'failed' || report.status === 'unavailable'
      ? t(report.message)
      : report.status === 'ended' && report.message
        ? t(report.message)
        : '';

  return (
    <span class="ec__translation-speech">
      <button
        type="button"
        class="ec__btn ec__speaker"
        data-clavis="card-translation-speak"
        aria-label={busy ? t('speechStop') : t('cardSpeakTranslation')}
        aria-pressed={busy ? 'true' : 'false'}
        title={busy ? t('speechStop') : t('cardSpeakTranslation')}
        onClick={(event) => {
          if (!isTrustedEvent(event)) return;
          if (busy) {
            stopRef.current?.();
            stopRef.current = null;
            setReport({ status: 'idle' });
          } else {
            stopRef.current?.();
            stopRef.current = host.speak?.(text, lang, (next) => reportRef.current(next)) ?? null;
          }
        }}
      >
        {busy ? (
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
          </svg>
        ) : (
          <span
            ref={(element) => {
              // Reuse only extension-owned toolbar artwork, including when a stopped icon remounts.
              const icon = element === null ? null : host.speakerIcon?.();
              if (element !== null && icon != null) element.replaceChildren(icon);
            }}
            aria-hidden="true"
          >
            {host.speakerIcon === undefined ? (
              <svg viewBox="0 0 24 24">
                <path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor" />
              </svg>
            ) : null}
          </span>
        )}
      </button>
      <span class="ec__speech-note" role="status">
        {message}
      </span>
    </span>
  );
}
