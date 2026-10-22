import { t } from '../../../lib/i18n';
import { ExternalLink, Notice } from '../../common/ui';
import type { StepContext } from '../StepTypes';

/** The bundled practice page works offline and without a key (it explains how to connect). */
export function PracticeStep({ keys }: StepContext) {
  const hasKey = keys.resource.state.status === 'ready' && keys.resource.state.data.hasKey;
  return (
    <>
      <p>{t('onbPracticeBody')}</p>
      {hasKey ? null : (
        <Notice>
          <p>{t('onbPracticeNoKey')}</p>
        </Notice>
      )}
      <div className="clavis-actions">
        <ExternalLink href="/practice.html" className="clavis-button clavis-button--primary">
          {t('onbPracticeOpen')}
        </ExternalLink>
      </div>
    </>
  );
}
