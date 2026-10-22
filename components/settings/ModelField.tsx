import { t } from '../../lib/i18n';
import { SelectField } from './fields';
import { modelChoices, type ModelListNote } from './models';
import type { KeyStatus } from '../../lib/contracts/setup';
import { Notice } from '../common/ui';

const AUTO = '';
const CHOOSE = '__choose__';

const NOTE_KEY = {
  'no-key': 'modelListNoKey',
  unchecked: 'modelListEmpty',
  unverified: 'modelListUnverified',
} as const satisfies Record<Exclude<ModelListNote, null>, string>;

interface ModelFieldProps {
  /** The saved model id, or undefined for Clavis's default. */
  model: string | undefined;
  keyStatus: KeyStatus | null;
  /** `null` = go back to the default model. */
  onChange(model: string | null): void;
}

/**
 * Model chooser (FR-005). Only models Groq listed for the user's key are offered. When the saved
 * model is no longer in that list the control says so and asks the user to choose: it never
 * switches models by itself, so a billable model can never be selected silently.
 */
export function ModelField({ model, keyStatus, onChange }: ModelFieldProps) {
  const { models, saved, savedMissing, note } = modelChoices(model, keyStatus);
  const savedListed = saved !== undefined && models.some((entry) => entry.id === saved);
  const value = savedMissing ? CHOOSE : (saved ?? AUTO);

  return (
    <div className="clavis-stack">
      {savedMissing && saved !== undefined ? (
        <div className="clavis-notice clavis-notice--warning" data-testid="model-missing">
          <p>{t('modelMissing', saved)}</p>
        </div>
      ) : null}
      <SelectField
        label={t('modelLabel')}
        value={value}
        onChange={(next) => onChange(next === AUTO ? null : next === CHOOSE ? null : next)}
        hint={t('modelPlanNote')}
      >
        {savedMissing ? (
          <option value={CHOOSE} disabled>
            {t('modelChoose')}
          </option>
        ) : null}
        <option value={AUTO}>{t('modelAuto')}</option>
        {/* A saved model that no list can confirm (offline, never checked) stays selectable. */}
        {saved !== undefined && !savedListed && !savedMissing ? (
          <option value={saved}>{saved}</option>
        ) : null}
        {models.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.id}
          </option>
        ))}
      </SelectField>
      {note === null ? null : (
        <Notice tone={note === 'unverified' ? 'warning' : 'info'}>
          <p>{t(NOTE_KEY[note])}</p>
        </Notice>
      )}
    </div>
  );
}
