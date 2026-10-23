import { useId } from 'react';
import { t } from '../../lib/i18n';
import type { SettingsHook } from '../../lib/ui-client/use-settings';
import { Button } from '../common/ui';
import { PreferencesForm } from './PreferencesForm';
import { ResourceGate } from './ResourceGate';
import { useSaveStatus } from './use-save-status';

interface PreferencesSectionProps {
  settings: SettingsHook;
}

/** Settings: the FR-006 preferences with immediate save and a reset to defaults. */
export function PreferencesSection({ settings }: PreferencesSectionProps) {
  const headingId = useId();
  const reset = useSaveStatus(settings.reset, t('prefResetDone'));

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-preferences">
      <h2 id={headingId}>{t('prefsTitle')}</h2>
      <ResourceGate resource={settings.resource}>
        {(snapshot) => (
          <>
            <PreferencesForm
              preferences={snapshot.preferences}
              save={settings.save}
              includeVoice={false}
            />
            <div className="clavis-actions">
              <Button onClick={() => void reset.run()}>{t('prefReset')}</Button>
            </div>
            <p className="clavis-hint">{t('prefResetHint')}</p>
            <p className="clavis-hint">{t('settingsReloadNote')}</p>
            {reset.notice}
          </>
        )}
      </ResourceGate>
    </section>
  );
}
