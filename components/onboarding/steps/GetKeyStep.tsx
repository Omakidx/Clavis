import { t } from '../../../lib/i18n';
import { GROQ_KEYS_URL } from '../../../lib/ui-client/links';
import { Button, ExternalLink } from '../../common/ui';
import type { StepContext } from '../StepTypes';

/** FR-003: send the user to GroqCloud's key page and explain how to copy a key. */
export function GetKeyStep({ goTo, skipKey }: StepContext) {
  return (
    <>
      <p>{t('onbGetKeyIntro')}</p>
      <ol>
        <li>
          {t('onbGetKeyStep1')}{' '}
          <ExternalLink href={GROQ_KEYS_URL}>{t('onbGetKeyLink')}</ExternalLink>
        </li>
        <li>{t('onbGetKeyStep2')}</li>
        <li>{t('onbGetKeyStep3')}</li>
      </ol>
      <p>{t('keyWarning')}</p>
      <div className="clavis-actions">
        <Button variant="primary" onClick={() => goTo('connect')}>
          {t('onbHaveKey')}
        </Button>
        <Button onClick={skipKey}>{t('onbSkipKey')}</Button>
      </div>
      <p className="clavis-muted">{t('onbSkipKeyHint')}</p>
    </>
  );
}
