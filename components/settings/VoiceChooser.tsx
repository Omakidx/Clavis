import { useEffect, useMemo, useRef, useState } from 'react';
import type { VoiceInfo, VoicesReport } from '../../lib/contracts/speech';
import type { Preferences } from '../../lib/contracts/setup';
import { t } from '../../lib/i18n';
import { Button, ErrorNotice, LiveStatus } from '../common/ui';
import { useToast } from '../common/Toast';
import { MicrophoneIcon } from '../common/Icons';
import { SelectField } from './fields';
import { useVoiceTest } from './use-voice-test';
import {
  ALL_LANGUAGES,
  allVoices,
  filterVoices,
  initialFilter,
  languageName,
  sampleFor,
  voiceLanguages,
} from './voice-model';

interface VoiceChooserProps {
  report: VoicesReport;
  preferences: Preferences;
  /** Persist `ttsVoice`; `null` = automatic. */
  onChange(voice: string | null): void;
  /** Onboarding: only the voice drop-down and the test button. */
  compact?: boolean;
}

const AUTOMATIC = '';

/** Online voices are labelled as such: playback sends the text to that service (D-22). */
function optionLabel(voice: VoiceInfo): string {
  if (voice.lang === undefined || voice.lang === '') {
    return voice.remote ? `${voice.name} ${t('voiceOnlineTag')}` : voice.name;
  }
  return voice.remote
    ? t('voiceOptionOnline', [voice.name, voice.lang])
    : t('voiceOption', [voice.name, voice.lang]);
}

/**
 * Voice chooser (FR-025): "Automatic (best match)" plus the voices that really exist, grouped by
 * on-device and online (D-22) and filtered by language, with a Test voice button. With no voices the drop-down and the
 * button are disabled, so nothing offers a choice that cannot play.
 */
export function VoiceChooser({
  report,
  preferences,
  onChange,
  compact = false,
}: VoiceChooserProps) {
  const voices = useMemo(() => allVoices(report), [report]);
  const [filter, setFilter] = useState(() => initialFilter(voices, preferences.ttsLang));
  // Follow a later change of the voice language (it can be changed beside this chooser): reset
  // the filter while rendering, when the language it was derived from changed.
  const [filterLang, setFilterLang] = useState(preferences.ttsLang);
  if (filterLang !== preferences.ttsLang) {
    setFilterLang(preferences.ttsLang);
    setFilter(initialFilter(voices, preferences.ttsLang));
  }
  const test = useVoiceTest();
  const toast = useToast();
  const testToastId = useRef<number | null>(null);
  const testState = test.state;
  useEffect(() => {
    if (!toast || testState.kind === 'idle') {
      if (toast && testToastId.current !== null) toast.dismiss(testToastId.current);
      testToastId.current = null;
      return;
    }
    const content =
      testState.kind === 'error' ? (
        <ErrorNotice error={testState.error} />
      ) : testState.kind === 'starting' ? (
        t('voiceTestStarting')
      ) : testState.kind === 'playing' ? (
        t('voiceTestPlaying')
      ) : (
        t('voiceTestDone')
      );
    testToastId.current = toast.show({
      content,
      tone: testState.kind === 'error' ? 'danger' : testState.kind === 'done' ? 'success' : 'info',
      ...(testState.kind === 'starting' || testState.kind === 'playing' ? { durationMs: 0 } : {}),
    });
  }, [testState, toast]);
  const saved = preferences.ttsVoice;
  const empty = voices.length === 0;
  const chosen = saved === undefined ? undefined : voices.find((voice) => voice.name === saved);
  const savedMissing = saved !== undefined && chosen === undefined;
  const shown = filterVoices(voices, compact ? ALL_LANGUAGES : filter, saved);
  const onDevice = shown.filter((voice) => !voice.remote);
  const online = shown.filter((voice) => voice.remote);
  const languages = voiceLanguages(voices);

  const options = (list: VoiceInfo[]) =>
    list.map((voice) => (
      <option key={`${voice.engine}:${voice.name}`} value={voice.name}>
        {optionLabel(voice)}
      </option>
    ));

  return (
    <div className="clavis-stack" data-testid="voice-chooser">
      {compact || empty || languages.length < 2 ? null : (
        <SelectField label={t('voiceLanguageFilter')} value={filter} onChange={setFilter}>
          <option value={ALL_LANGUAGES}>{t('voiceAllLanguages')}</option>
          {languages.map((code) => (
            <option key={code} value={code}>
              {languageName(code)}
            </option>
          ))}
        </SelectField>
      )}

      <SelectField
        label={t('voiceChooser')}
        hint={t('voiceChooserHint')}
        value={saved ?? AUTOMATIC}
        disabled={empty && saved === undefined}
        onChange={(value) => onChange(value === AUTOMATIC ? null : value)}
      >
        <option value={AUTOMATIC}>{t('voiceAutomatic')}</option>
        {savedMissing ? <option value={saved}>{t('voiceSavedMissing', saved)}</option> : null}
        {onDevice.length > 0 ? (
          <optgroup label={t('voiceGroupDevice')}>{options(onDevice)}</optgroup>
        ) : null}
        {online.length > 0 ? (
          <optgroup label={t('voiceGroupOnline')}>{options(online)}</optgroup>
        ) : null}
      </SelectField>

      {chosen?.remote === true ? (
        <p className="clavis-hint" data-testid="voice-online-note">
          {t('voiceOnlineNote')}
        </p>
      ) : null}

      <div className="clavis-actions">
        <Button
          className="clavis-button--voice-test"
          disabled={empty}
          onClick={() =>
            test.toggle({
              voiceName: chosen?.name,
              // An exact voice speaks as it is (its own language, or none known); only automatic
              // follows the voice language preference. Same rule Listen uses (FR-024).
              lang: chosen === undefined ? preferences.ttsLang : chosen.lang,
              rate: preferences.ttsRate,
              text: sampleFor(
                chosen === undefined ? preferences.ttsLang : chosen.lang,
                t('voiceTestSample'),
              ),
            })
          }
        >
          <MicrophoneIcon />
          {test.state.kind === 'playing' || test.state.kind === 'starting'
            ? t('speechStop')
            : t('voiceTest')}
        </Button>
      </div>
      {!toast ? <LiveStatus message={test.live} /> : null}
      {!toast && test.state.kind === 'error' ? <ErrorNotice error={test.state.error} /> : null}
    </div>
  );
}
