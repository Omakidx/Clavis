import { useState } from 'react';
import { TTS_RATES } from '../../lib/config/constants';
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
import { ModelField } from './ModelField';
import { useSaveStatus } from './use-save-status';

interface PreferencesFormProps {
  preferences: Preferences;
  /** Persist a change; the form shows the confirmation or error itself. */
  save(patch: PreferencesPatch): Promise<ClientResult<unknown>>;
  /** Include the model chooser (onboarding shows it with the other preferences). */
  keyStatus?: KeyStatus | null | undefined;
  includeModel?: boolean;
}

const AUTO_VOICE = '';

/**
 * FR-006 preference fields, shared by the onboarding wizard and Settings: explanation language,
 * voice language, reading level, playback speed and toolbar behaviour. Every change is saved
 * immediately and confirmed in a live region; a failed save is explained and the control
 * returns to the stored value (the page only ever shows what the background stored).
 */
export function PreferencesForm({
  preferences,
  save,
  keyStatus = null,
  includeModel = false,
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
    readingLevel: pending?.readingLevel ?? preferences.readingLevel,
    tooltipBehavior: pending?.tooltipBehavior ?? preferences.tooltipBehavior,
    ttsRate: pending?.ttsRate ?? preferences.ttsRate,
    // `null` in a patch means "cleared", `undefined` means "not part of this change".
    ttsLang: pending?.ttsLang === undefined ? preferences.ttsLang : (pending.ttsLang ?? undefined),
    model: pending?.model === undefined ? preferences.model : (pending.model ?? undefined),
  };
  const rate = view.ttsRate;
  const customRate = rate !== TTS_RATES.normal && rate !== TTS_RATES.slow;
  const speed = rate === TTS_RATES.normal ? 'normal' : rate === TTS_RATES.slow ? 'slow' : 'custom';

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
        label={t('prefVoiceLanguage')}
        hint={t('prefVoiceLanguageHint')}
        value={view.ttsLang ?? AUTO_VOICE}
        onChange={(value) => void change({ ttsLang: value === AUTO_VOICE ? null : value })}
      >
        <option value={AUTO_VOICE}>{t('prefVoiceLanguageAuto')}</option>
        {languageOptions(view.ttsLang).map((option) => (
          <option key={option.tag} value={option.tag}>
            {option.label}
          </option>
        ))}
      </SelectField>

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

      <RadioGroup<'normal' | 'slow' | 'custom'>
        legend={t('prefSpeed')}
        value={speed}
        onChange={(next) => {
          if (next === 'custom') return;
          const ttsRate = next === 'slow' ? TTS_RATES.slow : TTS_RATES.normal;
          void change({ ttsRate });
        }}
        options={[
          { value: 'normal', label: t('prefSpeedNormal') },
          { value: 'slow', label: t('prefSpeedSlow') },
          ...(customRate
            ? [
                {
                  value: 'custom' as const,
                  label: t('prefSpeedCustom', String(rate)),
                  disabled: true,
                },
              ]
            : []),
        ]}
      />

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
