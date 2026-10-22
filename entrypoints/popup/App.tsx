import { Page } from '../../components/common/Page';
import { t } from '../../lib/i18n';

function openReader() {
  void browser.tabs.create({ url: browser.runtime.getURL('/reader.html') });
  window.close();
}

function openSettings() {
  void browser.runtime.openOptionsPage();
  window.close();
}

export function App() {
  return (
    <Page title={t('extName')} size="narrow">
      <div className="page__actions">
        <button type="button" className="button button--primary" onClick={openReader}>
          {t('popupOpenReader')}
        </button>
        <button type="button" className="button" onClick={openSettings}>
          {t('popupSettings')}
        </button>
      </div>
    </Page>
  );
}
