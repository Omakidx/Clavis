import { useId } from 'react';
import { t } from '../../lib/i18n';
import { ExternalLink } from '../common/ui';

/** Settings: rerun the tutorial (FR-008), the practice page and the PDF reader. */
export function HelpSection() {
  const headingId = useId();
  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-help">
      <h2 id={headingId}>{t('helpTitle')}</h2>
      <ul>
        <li>
          <a href="/onboarding.html">{t('helpTutorial')}</a>
        </li>
        <li>
          <ExternalLink href="/practice.html">{t('helpPractice')}</ExternalLink>
        </li>
        <li>
          <ExternalLink href="/reader.html">{t('helpPdf')}</ExternalLink>
        </li>
      </ul>
      <p>{t('helpShortcut')}</p>
    </section>
  );
}
