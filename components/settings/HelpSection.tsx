import { useId } from 'react';
import { SETTINGS_SECTION_ANCHORS } from '../../lib/config/constants';
import { t } from '../../lib/i18n';
import { ExternalLink } from '../common/ui';
import { SettingsIcon } from '../common/Icons';
import { PdfHelp } from './PdfHelp';

/**
 * Settings: rerun the tutorial (FR-008), open the practice page, and the
 * help that explains Clavis's limits: PDFs (why not Chrome's viewer) and voices. Working without
 * website access is explained in the Website access section, which this links to.
 */
export function HelpSection() {
  const headingId = useId();
  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-help">
      <h2 id={headingId}>
        <SettingsIcon name="privacy" />
        {t('helpTitle')}
      </h2>
      <ul>
        <li>
          <a href="/onboarding.html">{t('helpTutorial')}</a>
        </li>
        <li>
          <ExternalLink href="/practice.html">{t('helpPractice')}</ExternalLink>
        </li>
        <li>
          <a href={`#${SETTINGS_SECTION_ANCHORS.site}`}>{t('siteHelpTitle')}</a>
        </li>
      </ul>
      <PdfHelp />
      <h3>{t('helpVoicesTitle')}</h3>
      <p>{t('helpVoicesBody')}</p>
      <p>{t('helpShortcut')}</p>
    </section>
  );
}
