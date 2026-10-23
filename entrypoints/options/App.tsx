import { useCallback, useEffect } from 'react';
import { Page } from '../../components/common/Page';
import { ApiKeySection } from '../../components/settings/ApiKeySection';
import { HelpSection } from '../../components/settings/HelpSection';
import { ModelSection } from '../../components/settings/ModelSection';
import { PreferencesSection } from '../../components/settings/PreferencesSection';
import { PrivacySection } from '../../components/settings/PrivacySection';
import { VoiceSection } from '../../components/settings/VoiceSection';
import { SiteAccessSection } from '../../components/settings/SiteAccessSection';
import { t } from '../../lib/i18n';
import { useKeyStatus } from '../../lib/ui-client/use-key-status';
import { useSettings } from '../../lib/ui-client/use-settings';

const SECTIONS = [
  { id: 'section-key', label: 'keyTitle' },
  { id: 'section-model', label: 'modelTitle' },
  { id: 'section-preferences', label: 'prefsTitle' },
  { id: 'section-voice', label: 'voiceTitle' },
  { id: 'section-site-access', label: 'siteTitle' },
  { id: 'section-privacy', label: 'privacyTitle' },
  { id: 'section-help', label: 'helpTitle' },
] as const;

/**
 * Settings sections are rendered after the page loads, so the browser's own jump to `#section-…`
 * finds nothing. Scroll to the section once it exists, and keep it in view while the sections
 * above it settle (voices and the key status load asynchronously), until the person scrolls.
 */
function useScrollToSectionInUrl(): void {
  useEffect(() => {
    let id = '';
    try {
      id = decodeURIComponent(window.location.hash.slice(1));
    } catch {
      return;
    }
    if (id === '') return;
    const go = () => document.getElementById(id)?.scrollIntoView({ block: 'start' });
    go();
    const observer = new ResizeObserver(go);
    observer.observe(document.body);
    const stop = () => observer.disconnect();
    const timer = window.setTimeout(stop, 2000);
    const events = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;
    for (const type of events) window.addEventListener(type, stop, { once: true });
    return () => {
      window.clearTimeout(timer);
      stop();
      for (const type of events) window.removeEventListener(type, stop);
    };
  }, []);
}

/** Settings (opens in a tab). One page, one section per concern, jump links at the top. */
export function App() {
  const keys = useKeyStatus();
  const settings = useSettings();
  const reloadKeys = keys.resource.reload;
  const reloadSettings = settings.resource.reload;
  useScrollToSectionInUrl();

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
      <VoiceSection settings={settings} />
      <SiteAccessSection settings={settings} />
      <PrivacySection onCleared={afterClear} />
      <HelpSection />
    </Page>
  );
}
