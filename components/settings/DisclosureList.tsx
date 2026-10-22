import { t } from '../../lib/i18n';
import { GROQ_PRIVACY_URL } from '../../lib/ui-client/links';
import { ExternalLink } from '../common/ui';

/**
 * The approved data-disclosure bullets (requirements.md "Approved disclosure copy", D-16),
 * shown in onboarding and again under Privacy in Settings. Wording comes from the catalog
 * unchanged; do not shorten or soften it here.
 */
export function DisclosureList() {
  return (
    <ul>
      <li>{t('disclosureSelect')}</li>
      <li>{t('disclosureListen')}</li>
      <li>
        {t('disclosureExplain')}{' '}
        <ExternalLink href={GROQ_PRIVACY_URL}>{t('disclosurePrivacyLink')}</ExternalLink>
      </li>
      <li>{t('disclosurePdf')}</li>
      <li>{t('disclosureNoServer')}</li>
    </ul>
  );
}
