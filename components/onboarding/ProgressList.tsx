import { t } from '../../lib/i18n';
import { STEPS, STEP_NAME, type StepId } from './steps';

interface ProgressListProps {
  current: StepId;
}

/**
 * Where the user is in setup. A real ordered list inside a labelled <nav>, with the current
 * item marked by aria-current="step" and spoken text for current/completed, so progress never
 * depends on colour alone.
 */
export function ProgressList({ current }: ProgressListProps) {
  const currentIndex = STEPS.indexOf(current);
  return (
    <nav aria-label={t('onbProgressLabel')}>
      <ol className="clavis-progress">
        {STEPS.map((step, index) => {
          const state = index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
          return (
            <li
              key={step}
              className={`clavis-progress__item clavis-progress__item--${state}`}
              {...(state === 'current' ? { 'aria-current': 'step' as const } : {})}
            >
              <span className="clavis-progress__number" aria-hidden="true">
                {state === 'done' ? '✓' : index + 1}
              </span>
              <span className="clavis-progress__name">{t(STEP_NAME[step])}</span>
              {state === 'current' ? (
                <span className="clavis-sr-only"> {t('onbStepCurrent')}</span>
              ) : null}
              {state === 'done' ? (
                <span className="clavis-sr-only"> {t('onbStepComplete')}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
