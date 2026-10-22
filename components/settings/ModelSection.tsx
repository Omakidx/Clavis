import { useId } from 'react';
import { t } from '../../lib/i18n';
import type { KeyStatusHook } from '../../lib/ui-client/use-key-status';
import type { SettingsHook } from '../../lib/ui-client/use-settings';
import { ModelField } from './ModelField';
import { ResourceGate } from './ResourceGate';
import { useSaveStatus } from './use-save-status';
import type { PreferencesPatch } from '../../lib/contracts/setup';

interface ModelSectionProps {
  settings: SettingsHook;
  keys: KeyStatusHook;
}

/** Settings: model chooser fed by the models the user's key can use (FR-005). */
export function ModelSection({ settings, keys }: ModelSectionProps) {
  const headingId = useId();
  const { run, notice } = useSaveStatus((patch: PreferencesPatch) => settings.save(patch));
  const keyState = keys.resource.state;
  const keyStatus = keyState.status === 'ready' ? keyState.data : null;

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-model">
      <h2 id={headingId}>{t('modelTitle')}</h2>
      <ResourceGate resource={settings.resource}>
        {(snapshot) => (
          <>
            <ModelField
              model={snapshot.preferences.model}
              keyStatus={keyStatus}
              onChange={(model) => void run({ model })}
            />
            {notice}
          </>
        )}
      </ResourceGate>
    </section>
  );
}
