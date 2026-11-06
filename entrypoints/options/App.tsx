import { useCallback, useEffect, useState } from 'react';
import { Page } from '../../components/common/Page';
import { ToastProvider } from '../../components/common/Toast';
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
import { SettingsIcon } from '../../components/settings/SettingsIcon';
import './options.css';

const GROUPS = [
  { id: 'connection', anchor: 'section-key', label: 'optionsGroupConnection' },
  { id: 'preferences', anchor: 'section-preferences', label: 'prefsTitle' },
  { id: 'website', anchor: 'section-site-access', label: 'siteTitle' },
  { id: 'privacy', anchor: 'section-privacy', label: 'optionsGroupPrivacyHelp' },
] as const;

type Group = (typeof GROUPS)[number]['id'];

const ANCHOR_GROUP: Record<string, Group> = {
  'section-key': 'connection',
  'section-model': 'connection',
  'section-preferences': 'preferences',
  'section-voice': 'preferences',
  'section-site-access': 'website',
  'section-privacy': 'privacy',
  'section-help': 'privacy',
  'section-help-pdf': 'privacy',
};

function hashTarget(): string {
  try {
    return decodeURIComponent(window.location.hash.slice(1));
  } catch {
    return '';
  }
}

function initialGroup(): Group {
  return ANCHOR_GROUP[hashTarget()] ?? 'connection';
}

/** Settings keeps every panel mounted so an in-flight save can settle after navigation. */
export function App() {
  return (
    <ToastProvider>
      <SettingsPage />
    </ToastProvider>
  );
}

function SettingsPage() {
  const keys = useKeyStatus();
  const settings = useSettings();
  const [group, setGroup] = useState<Group>(initialGroup);
  const reloadKeys = keys.resource.reload;
  const reloadSettings = settings.resource.reload;

  useEffect(() => {
    let stopTracking = () => {};
    const syncHash = () => {
      stopTracking();
      const target = hashTarget();
      setGroup(ANCHOR_GROUP[target] ?? 'connection');
      if (target in ANCHOR_GROUP) {
        // Async key and voice reports can move a deep target after the first paint.
        const go = () => document.getElementById(target)?.scrollIntoView?.({ block: 'start' });
        const frame = window.requestAnimationFrame(go);
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(go);
        observer?.observe(document.body);
        const events = ['wheel', 'keydown', 'pointerdown', 'touchstart'] as const;
        const stop = () => {
          observer?.disconnect();
          for (const type of events) window.removeEventListener(type, stop);
        };
        const timer = window.setTimeout(stop, 2000);
        for (const type of events) window.addEventListener(type, stop, { once: true });
        stopTracking = () => {
          window.cancelAnimationFrame(frame);
          window.clearTimeout(timer);
          stop();
        };
      }
    };
    syncHash();
    window.addEventListener('hashchange', syncHash);
    return () => {
      window.removeEventListener('hashchange', syncHash);
      stopTracking();
    };
  }, []);

  const afterClear = useCallback(() => {
    reloadKeys();
    reloadSettings();
  }, [reloadKeys, reloadSettings]);

  return (
    <Page title={t('optionsTitle')}>
      <div className="clavis-settings">
        <nav className="clavis-settings__nav" aria-label={t('optionsNavLabel')}>
          <ul className="clavis-settings__nav-list">
            {GROUPS.map((item) => (
              <li key={item.id}>
                <a
                  href={`#${item.anchor}`}
                  aria-current={group === item.id ? 'page' : undefined}
                  onClick={() => {
                    setGroup(item.id);
                    window.requestAnimationFrame(() => {
                      document.getElementById(item.anchor)?.querySelector('h2')?.focus();
                    });
                  }}
                >
                  <SettingsIcon name={item.id} />
                  <span>{t(item.label)}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <div className="clavis-settings__content">
          <div hidden={group !== 'connection'}>
            <ApiKeySection keys={keys} active={group === 'connection'} />
            <ModelSection settings={settings} keys={keys} />
          </div>
          <div hidden={group !== 'preferences'}>
            <PreferencesSection settings={settings} />
            <VoiceSection settings={settings} />
          </div>
          <div hidden={group !== 'website'}>
            <SiteAccessSection settings={settings} />
          </div>
          <div hidden={group !== 'privacy'}>
            <PrivacySection onCleared={afterClear} />
            <HelpSection />
          </div>
        </div>
      </div>
    </Page>
  );
}
