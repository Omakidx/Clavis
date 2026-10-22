import { useCallback } from 'react';
import { Page } from '../../components/common/Page';
import { ApiKeySection } from '../../components/settings/ApiKeySection';
import { HelpSection } from '../../components/settings/HelpSection';
import { ModelSection } from '../../components/settings/ModelSection';
import { PreferencesSection } from '../../components/settings/PreferencesSection';
import { PrivacySection } from '../../components/settings/PrivacySection';
import { SiteAccessSection } from '../../components/settings/SiteAccessSection';
import { t } from '../../lib/i18n';
import { useKeyStatus } from '../../lib/ui-client/use-key-status';
import { useSettings } from '../../lib/ui-client/use-settings';

const SECTIONS = [
  { id: 'section-key', label: 'keyTitle' },
  { id: 'section-model', label: 'modelTitle' },
  { id: 'section-preferences', label: 'prefsTitle' },
  { id: 'section-site-access', label: 'siteTitle' },
  { id: 'section-privacy', label: 'privacyTitle' },
  { id: 'section-help', label: 'helpTitle' },
] as const;

/** Settings (opens in a tab). One page, one section per concern, jump links at the top. */
export function App() {
  const keys = useKeyStatus();
  const settings = useSettings();
  const reloadKeys = keys.resource.reload;
  const reloadSettings = settings.resource.reload;

  const afterClear = useCallback(() => {
    reloadKeys();
    reloadSettings();
  }, [reloadKeys, reloadSettings]);

  return (
    <Page title={t('optionsTitle')}>
      <nav aria-label={t('optionsNavLabel')}>
        <ul className="clavis-nav">
          {SECTIONS.map((section) => (
            <li key={section.id}>
              <a href={`#${section.id}`}>{t(section.label)}</a>
            </li>
          ))}
        </ul>
      </nav>
      <ApiKeySection keys={keys} />
      <ModelSection settings={settings} keys={keys} />
      <PreferencesSection settings={settings} />
      <SiteAccessSection settings={settings} />
      <PrivacySection onCleared={afterClear} />
      <HelpSection />
    </Page>
  );
}
