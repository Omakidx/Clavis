import { useId } from 'react';
import { Page } from '../../components/common/Page';
import { t } from '../../lib/i18n';

// TODO(Phase 3): move to lib/config once it exposes provider constants.
const GROQ_PRIVACY_URL = 'https://groq.com/privacy-policy/';

export function App() {
  const disclosureId = useId();
  const siteAccessId = useId();

  return (
    <Page title={t('onboardingTitle')}>
      <section aria-labelledby={disclosureId}>
        <h2 id={disclosureId}>{t('disclosureTitle')}</h2>
        <ul>
          <li>{t('disclosureSelect')}</li>
          <li>{t('disclosureListen')}</li>
          <li>
            {t('disclosureExplain')}{' '}
            <a href={GROQ_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
              {t('disclosurePrivacyLink')}
            </a>
          </li>
          <li>{t('disclosurePdf')}</li>
          <li>{t('disclosureNoServer')}</li>
        </ul>
        <div className="page__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              // TODO(Phase 3): persist the disclosure acknowledgement (FR-002).
            }}
          >
            {t('disclosureAccept')}
          </button>
        </div>
      </section>

      <section aria-labelledby={siteAccessId}>
        <h2 id={siteAccessId}>{t('siteAccessTitle')}</h2>
        <p>{t('siteAccessBody')}</p>
        <div className="page__actions">
          <button
            type="button"
            className="button button--primary"
            onClick={() => {
              // TODO(Phase 3): request optional host permissions from this user gesture (D-02, FR-009).
            }}
          >
            {t('siteAccessGrant')}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              // TODO(Phase 3): record that site access was declined; right-click stays available (FR-018).
            }}
          >
            {t('siteAccessSkip')}
          </button>
        </div>
      </section>
    </Page>
  );
}
