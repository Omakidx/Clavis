import { useId, useState } from 'react';
import type { VoicesReport } from '../../lib/contracts/speech';
import type { Preferences, PreferencesPatch } from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import { api } from '../../lib/ui-client/api';
import type { SettingsHook } from '../../lib/ui-client/use-settings';
import { useResource } from '../../lib/ui-client/use-resource';
import { Notice } from '../common/ui';
import { ResourceGate } from './ResourceGate';
import { useSaveStatus } from './use-save-status';
import { SpeedField, VoiceLanguageField } from './VoiceFields';
import { VoiceChooser } from './VoiceChooser';
import { allVoices } from './voice-model';

interface VoiceSectionProps {
  settings: SettingsHook;
}

/** What each engine found, plainly (this is where the D-07 check is read off). */
function VoiceCounts({ report }: { report: VoicesReport }) {
  const { chromeTts, offscreen } = report.engines;
  const engine =
    report.defaultEngine === 'chrome-tts'
      ? t('voiceEngineChrome')
      : report.defaultEngine === 'offscreen-web-speech'
        ? t('voiceEngineFallback')
        : null;
  return (
    <div data-testid="voice-counts">
      <h3>{t('voiceDevice')}</h3>
      <ul>
        <li data-engine="chrome-tts">
          {t('voiceCount', [t('voiceEngineChrome'), String(chromeTts.voices.length)])}
        </li>
        <li data-engine="offscreen-web-speech">
          {offscreen.available
            ? t('voiceCount', [t('voiceEngineFallback'), String(offscreen.voices.length)])
            : t('voiceFallbackOff')}
        </li>
      </ul>
      {engine === null ? null : <p className="clavis-hint">{t('voiceDefaultEngine', engine)}</p>}
    </div>
  );
}

/** No voice anywhere: say so, and (on Linux) how to get one. */
function NoVoices({ report }: { report: VoicesReport }) {
  return (
    <Notice tone="warning">
      <h3>{t('voiceEmpty')}</h3>
      <p>{t(report.platform === 'linux' ? 'speechNoVoiceLinuxHint' : 'speechNoVoiceHint')}</p>
    </Notice>
  );
}

function Fields({
  report,
  preferences,
  save,
}: {
  report: VoicesReport;
  preferences: Preferences;
  save: SettingsHook['save'];
}) {
  const { run, notice } = useSaveStatus(save);
  const [pending, setPending] = useState<PreferencesPatch | null>(null);

  /** Show the choice at once, then settle on whatever was really stored. */
  async function change(patch: PreferencesPatch) {
    setPending(patch);
    await run(patch);
    setPending(null);
  }

  const ttsLang =
    pending?.ttsLang === undefined ? preferences.ttsLang : (pending.ttsLang ?? undefined);
  const ttsVoice =
    pending?.ttsVoice === undefined ? preferences.ttsVoice : (pending.ttsVoice ?? undefined);
  const { ttsLang: _lang, ttsVoice: _voice, ...rest } = preferences;
  const shown: Preferences = {
    ...rest,
    ttsRate: pending?.ttsRate ?? preferences.ttsRate,
    ...(ttsLang === undefined ? {} : { ttsLang }),
    ...(ttsVoice === undefined ? {} : { ttsVoice }),
  };

  return (
    <div className="clavis-stack">
      <VoiceLanguageField value={ttsLang} onChange={(next) => void change({ ttsLang: next })} />
      <SpeedField rate={shown.ttsRate} onChange={(ttsRate) => void change({ ttsRate })} />
      {allVoices(report).length === 0 ? <NoVoices report={report} /> : null}
      <VoiceChooser
        report={report}
        preferences={shown}
        onChange={(voice) => void change({ ttsVoice: voice })}
      />
      {notice}
    </div>
  );
}

/**
 * Settings > Voice (FR-025, FR-006): which voices this device really has, per engine; the voice
 * Listen should use; the voice language and default speed; and a Test voice button. Works without
 * a Groq key and sends nothing to Groq.
 */
export function VoiceSection({ settings }: VoiceSectionProps) {
  const headingId = useId();
  const voices = useResource(api.getVoices);

  return (
    <section className="clavis-section" aria-labelledby={headingId} id="section-voice">
      <h2 id={headingId}>{t('voiceTitle')}</h2>
      <p>{t('voiceIntro')}</p>
      <ResourceGate resource={voices}>
        {(report) => (
          <>
            <VoiceCounts report={report} />
            <ResourceGate resource={settings.resource}>
              {(snapshot) => (
                <Fields report={report} preferences={snapshot.preferences} save={settings.save} />
              )}
            </ResourceGate>
          </>
        )}
      </ResourceGate>
    </section>
  );
}

function CompactFields({
  report,
  preferences,
  save,
}: {
  report: VoicesReport;
  preferences: Preferences;
  save: SettingsHook['save'];
}) {
  const { run, notice } = useSaveStatus(save);
  if (allVoices(report).length === 0) return <NoVoices report={report} />;
  return (
    <>
      <VoiceChooser
        compact
        report={report}
        preferences={preferences}
        onChange={(voice) => void run({ ttsVoice: voice })}
      />
      {notice}
    </>
  );
}

/**
 * The voice chooser for onboarding: just the drop-down and Test voice, or the "no voices" note
 * when the device has none. The full section (counts, language filter) lives in Settings.
 */
export function VoiceStepField({ settings }: VoiceSectionProps) {
  const voices = useResource(api.getVoices);
  return (
    <ResourceGate resource={voices}>
      {(report) => (
        <ResourceGate resource={settings.resource}>
          {(snapshot) => (
            <CompactFields
              report={report}
              preferences={snapshot.preferences}
              save={settings.save}
            />
          )}
        </ResourceGate>
      )}
    </ResourceGate>
  );
}
