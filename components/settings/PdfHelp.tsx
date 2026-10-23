import { t } from '../../lib/i18n';
import { SETTINGS_SECTION_ANCHORS } from '../../lib/config/constants';
import { ExternalLink } from '../common/ui';

/**
 * Why Chrome's built-in PDF viewer can't host the Clavis toolbar and how to open a PDF in the
 * Clavis reader (Phase 8; FR-056, D-03), with the limits people hit: scans, passwords and XFA forms.
 * Local files only. The root carries the anchor the popup and the reader link to.
 */
export function PdfHelp() {
  return (
    <div className="clavis-help" id={SETTINGS_SECTION_ANCHORS.pdfHelp} data-testid="pdf-help">
      <h3>{t('pdfHelpTitle')}</h3>
      <p>{t('pdfHelpWhy')}</p>
      <p>{t('pdfHelpIntro')}</p>
      <ol>
        <li>{t('pdfHelpStep1')}</li>
        <li>{t('pdfHelpStep2')}</li>
        <li>{t('pdfHelpStep3')}</li>
      </ol>
      <p>
        <ExternalLink href="/reader.html">{t('helpPdf')}</ExternalLink>
      </p>
      <p>{t('pdfHelpWebPdf')}</p>
      <h4>{t('pdfHelpLimitsTitle')}</h4>
      <ul>
        <li>{t('disclosurePdf')}</li>
        <li>{t('pdfHelpLimitScan')}</li>
        <li>{t('pdfHelpLimitPassword')}</li>
        <li>{t('pdfHelpLimitXfa')}</li>
      </ul>
    </div>
  );
}
