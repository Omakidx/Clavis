import { Page } from '../../components/common/Page';
import { t } from '../../lib/i18n';

export function App() {
  return (
    <Page title={t('readerTitle')}>
      <p>{t('readerPlaceholder')}</p>
    </Page>
  );
}
