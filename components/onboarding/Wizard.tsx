import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { useKeyStatus } from '../../lib/ui-client/use-key-status';
import { useSettings } from '../../lib/ui-client/use-settings';
import { Button, useFocusOnChange } from '../common/ui';
import { ProgressList } from './ProgressList';
import type { StepContext } from './StepTypes';
import { ConnectStep } from './steps/ConnectStep';
import { DisclosureStep } from './steps/DisclosureStep';
import { DoneStep } from './steps/DoneStep';
import { GetKeyStep } from './steps/GetKeyStep';
import { PracticeStep } from './steps/PracticeStep';
import { PreferencesStep } from './steps/PreferencesStep';
import { PurposeStep } from './steps/PurposeStep';
import { SiteAccessStep } from './steps/SiteAccessStep';
import { STEPS, STEP_HEADING, canAdvance, nextStep, previousStep, type StepId } from './steps';

const BODY: Record<StepId, (context: StepContext) => ReactNode> = {
  purpose: () => <PurposeStep />,
  disclosure: (context) => <DisclosureStep {...context} />,
  access: (context) => <SiteAccessStep {...context} />,
  'get-key': (context) => <GetKeyStep {...context} />,
  connect: (context) => <ConnectStep {...context} />,
  preferences: (context) => <PreferencesStep {...context} />,
  practice: (context) => <PracticeStep {...context} />,
  done: (context) => <DoneStep {...context} />,
};

/**
 * The first-run wizard (UJ-01): purpose, data disclosure, website access, Groq key, connect,
 * preferences, practice, done. Back and Next are always real buttons; focus moves to each
 * step's heading; one step at a time keeps the page usable at 200% zoom.
 */
export function Wizard() {
  const settings = useSettings();
  const keys = useKeyStatus();
  const [step, setStep] = useState<StepId>('purpose');
  const [keySkipped, setKeySkipped] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const [nextFocusRequests, setNextFocusRequests] = useState(0);

  useFocusOnChange(headingRef, step);

  const settingsState = settings.resource.state;
  const keyState = keys.resource.state;
  const facts = {
    onboarding: settingsState.status === 'ready' ? settingsState.data.onboarding : null,
    hasKey: keyState.status === 'ready' && keyState.data.hasKey,
    keySkipped,
  };

  // After an action unlocks "Next" (I understand, a site-access answer, a saved key) the user
  // would otherwise have to tab back to it. Wait for the button to render, then focus it.
  const advanceable = canAdvance(step, facts);
  useEffect(() => {
    if (nextFocusRequests > 0 && advanceable) nextRef.current?.focus();
  }, [nextFocusRequests, advanceable]);

  const focusNext = useCallback(() => setNextFocusRequests((count) => count + 1), []);
  const skipKey = useCallback(() => {
    setKeySkipped(true);
    setStep('preferences');
  }, []);

  const context: StepContext = { settings, keys, skipKey, goTo: setStep, focusNext };
  const index = STEPS.indexOf(step);
  const nextLabel =
    step === 'get-key' ? null : step === 'connect' ? t('onbConnectContinue') : t('uiNext');

  return (
    <div className="clavis-wizard">
      <ProgressList current={step} />
      <section className="clavis-section clavis-wizard__panel" aria-labelledby="wizard-heading">
        <p className="clavis-muted clavis-wizard__count">
          {t('onbStepOf', [String(index + 1), String(STEPS.length)])}
        </p>
        <h2 id="wizard-heading" ref={headingRef} tabIndex={-1}>
          {t(STEP_HEADING[step])}
        </h2>
        {BODY[step](context)}
        <div className="clavis-actions clavis-wizard__nav">
          {step === 'purpose' ? null : (
            <Button onClick={() => setStep(previousStep(step))}>{t('uiBack')}</Button>
          )}
          {advanceable && nextLabel !== null ? (
            <Button variant="primary" ref={nextRef} onClick={() => setStep(nextStep(step))}>
              {nextLabel}
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
