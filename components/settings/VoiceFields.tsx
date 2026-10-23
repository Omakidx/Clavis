import { TTS_RATES } from '../../lib/config/constants';
import { t } from '../../lib/i18n';
import { RadioGroup, SelectField } from './fields';
import { languageOptions } from './languages';

const AUTO_VOICE = '';

interface VoiceLanguageFieldProps {
  /** `undefined` = "Same as the text". */
  value: string | undefined;
  /** `null` clears the preference. */
  onChange(value: string | null): void;
}

/** FR-006 voice language (ttsLang): used to pick a voice for Listen. */
export function VoiceLanguageField({ value, onChange }: VoiceLanguageFieldProps) {
  return (
    <SelectField
      label={t('prefVoiceLanguage')}
      hint={t('prefVoiceLanguageHint')}
      value={value ?? AUTO_VOICE}
      onChange={(next) => onChange(next === AUTO_VOICE ? null : next)}
    >
      <option value={AUTO_VOICE}>{t('prefVoiceLanguageAuto')}</option>
      {languageOptions(value).map((option) => (
        <option key={option.tag} value={option.tag}>
          {option.label}
        </option>
      ))}
    </SelectField>
  );
}

interface SpeedFieldProps {
  rate: number;
  onChange(rate: number): void;
}

/** FR-006 default playback speed (Normal or Slow); a custom stored value is shown, not overwritten. */
export function SpeedField({ rate, onChange }: SpeedFieldProps) {
  const customRate = rate !== TTS_RATES.normal && rate !== TTS_RATES.slow;
  const speed = rate === TTS_RATES.normal ? 'normal' : rate === TTS_RATES.slow ? 'slow' : 'custom';
  return (
    <RadioGroup<'normal' | 'slow' | 'custom'>
      legend={t('prefSpeed')}
      value={speed}
      onChange={(next) => {
        if (next === 'custom') return;
        onChange(next === 'slow' ? TTS_RATES.slow : TTS_RATES.normal);
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
  );
}
