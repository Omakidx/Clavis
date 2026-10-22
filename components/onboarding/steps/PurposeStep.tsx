import { t } from '../../../lib/i18n';

export function PurposeStep() {
  return (
    <>
      <p>{t('onbPurposeIntro')}</p>
      <ul>
        <li>{t('onbPurposeListen')}</li>
        <li>{t('onbPurposeExplain')}</li>
      </ul>
      <p>{t('onbPurposeTime')}</p>
    </>
  );
}
