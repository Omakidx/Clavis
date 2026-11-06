import { Page } from '../../components/common/Page';
import type { StepId } from '../../components/onboarding/steps';
import { Wizard } from '../../components/onboarding/Wizard';
import { t } from '../../lib/i18n';
import './onboarding.css';

/** First-run setup (FR-001). Also reachable later from Settings > Help. */
export function App({ initialStep }: { initialStep?: StepId }) {
  return (
    <Page title={t('onboardingTitle')}>
      <div className="clavis-onboarding">
        <Wizard {...(initialStep ? { initialStep } : {})} />
      </div>
    </Page>
  );
}
