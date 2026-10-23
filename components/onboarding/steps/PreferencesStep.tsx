import { t } from '../../../lib/i18n';
import { PreferencesForm } from '../../settings/PreferencesForm';
import { ResourceGate } from '../../settings/ResourceGate';
import { VoiceStepField } from '../../settings/VoiceSection';
import type { StepContext } from '../StepTypes';

/** FR-006: language, reading level, speed, toolbar behaviour and (when known) the model. */
export function PreferencesStep({ settings, keys }: StepContext) {
  const keyState = keys.resource.state;
  return (
    <>
      <p>{t('onbPrefsIntro')}</p>
      <ResourceGate resource={settings.resource}>
        {(snapshot) => (
          <PreferencesForm
            preferences={snapshot.preferences}
            save={settings.save}
            keyStatus={keyState.status === 'ready' ? keyState.data : null}
            includeModel
          />
        )}
      </ResourceGate>
      <VoiceStepField settings={settings} />
    </>
  );
}
