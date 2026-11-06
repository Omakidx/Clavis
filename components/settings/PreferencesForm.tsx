import { useState } from 'react';
import type {
  KeyStatus,
  Preferences,
  PreferencesPatch,
  ReadingLevel,
  TooltipBehavior,
} from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import type { ClientResult } from '../../lib/ui-client/request';
import { RadioGroup, SelectField } from './fields';
import { languageOptions } from './languages';
import { SpeedField, VoiceLanguageField } from './VoiceFields';
import { ModelField } from './ModelField';
import { useSaveStatus } from './use-save-status';

interface PreferencesFormProps {
  preferences: Preferences;
  /** Persist a change; the form shows the confirmation or error itself. */
  save(patch: PreferencesPatch): Promise<ClientResult<unknown>>;
  /** Include the model chooser (onboarding shows it with the other preferences). */
  keyStatus?: KeyStatus | null | undefined;
  includeModel?: boolean;
  /**
   * Include the voice language and playback speed (default). Settings shows them in its Voice
   * section instead, next to the voice chooser.
   */
  includeVoice?: boolean;
}

/**
 * FR-006 preference fields, shared by the onboarding wizard and Settings: explanation and translation languages,
 * voice language, reading level, playback speed and toolbar behaviour. Every change is saved
 * immediately and confirmed in a live region; a failed save is explained and the control
 * returns to the stored value (the page only ever shows what the background stored).
 */
export function PreferencesForm({
  preferences,
  save,
  keyStatus = null,
  includeModel = false,
  includeVoice = true,
}: PreferencesFormProps) {
  const { run, notice } = useSaveStatus(save);
  const [pending, setPending] = useState<PreferencesPatch | null>(null);

  /** Show the choice at once, then settle on whatever was really stored. */
  async function change(patch: PreferencesPatch) {
    setPending(patch);
    await run(patch);
    setPending(null);
  }

  const view = {
    explanationLanguage: pending?.explanationLanguage ?? preferences.explanationLanguage,
    translationLanguage:
      pending?.translationLanguage ??
      preferences.translationLanguage ??
      pending?.explanationLanguage ??
      preferences.explanationLanguage,
    readingLevel: pending?.readingLevel ?? preferences.readingLevel,
    tooltipBehavior: pending?.tooltipBehavior ?? preferences.tooltipBehavior,
    ttsRate: pending?.ttsRate ?? preferences.ttsRate,
    // `null` in a patch means "cleared", `undefined` means "not part of this change".
    ttsLang: pending?.ttsLang === undefined ? preferences.ttsLang : (pending.ttsLang ?? undefined),
    model: pending?.model === undefined ? preferences.model : (pending.model ?? undefined),
  };

  return (
    <div className="clavis-stack">
      <SelectField
        label={t('prefLanguage')}
        hint={t('prefLanguageHint')}
        value={view.explanationLanguage}
        onChange={(value) => void change({ explanationLanguage: value })}
      >
        {languageOptions(view.explanationLanguage).map((option) => (
          <option key={option.tag} value={option.tag}>
            {option.label}
          </option>
        ))}
      </SelectField>

      <SelectField
        label={t('prefTranslationLanguage')}
        hint={t('prefTranslationLanguageHint')}
        value={view.translationLanguage}
        onChange={(value) => void change({ translationLanguage: value })}
      >
        {languageOptions(view.translationLanguage).map((option) => (
          <option key={option.tag} value={option.tag}>
            {option.label}
          </option>
        ))}
      </SelectField>

      {includeVoice ? (
        <VoiceLanguageField value={view.ttsLang} onChange={(ttsLang) => void change({ ttsLang })} />
      ) : null}

      <RadioGroup<ReadingLevel>
        legend={t('prefLevel')}
        value={view.readingLevel}
        onChange={(readingLevel) => void change({ readingLevel })}
        options={[
          { value: 'simple', label: t('prefLevelSimple') },
          { value: 'standard', label: t('prefLevelStandard') },
          { value: 'advanced', label: t('prefLevelAdvanced') },
        ]}
      />

      {includeVoice ? (
        <SpeedField rate={view.ttsRate} onChange={(ttsRate) => void change({ ttsRate })} />
      ) : null}

      <RadioGroup<TooltipBehavior>
        legend={t('prefTooltip')}
        value={view.tooltipBehavior}
        onChange={(tooltipBehavior) => void change({ tooltipBehavior })}
        options={[
          { value: 'automatic', label: t('prefTooltipAutomatic') },
          { value: 'on-demand', label: t('prefTooltipOnDemand') },
        ]}
      />

      {includeModel ? (
        <ModelField
          model={view.model}
          keyStatus={keyStatus}
          onChange={(model) => void change({ model })}
        />
      ) : null}

      {notice}
    </div>
  );
}
