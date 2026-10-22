import { Page } from '../../components/common/Page';
import { Wizard } from '../../components/onboarding/Wizard';
import { t } from '../../lib/i18n';

/** First-run setup (FR-001). Also reachable later from Settings > Help. */
export function App() {
  return (
    <Page title={t('onboardingTitle')}>
      <Wizard />
    </Page>
  );
}
