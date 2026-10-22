import { useId } from 'react';
import type { ReactNode } from 'react';

export interface ChoiceOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
}

interface RadioGroupProps<T extends string> {
  legend: string;
  options: readonly ChoiceOption<T>[];
  value: T | null;
  onChange(value: T): void;
  hint?: string | undefined;
  disabled?: boolean | undefined;
}

/** A native radio group: arrow keys move, one tab stop, the legend names it for screen readers. */
export function RadioGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
  hint,
  disabled,
}: RadioGroupProps<T>) {
  const name = useId();
  const hintId = useId();
  return (
    <fieldset className="clavis-fieldset" aria-describedby={hint ? hintId : undefined}>
      <legend>{legend}</legend>
      {options.map((option) => (
        <label className="clavis-choice" key={option.value}>
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={value === option.value}
            disabled={disabled === true || option.disabled === true}
            onChange={() => onChange(option.value)}
          />
          <span className="clavis-choice__text">{option.label}</span>
        </label>
      ))}
      {hint ? (
        <p id={hintId} className="clavis-hint">
          {hint}
        </p>
      ) : null}
    </fieldset>
  );
}

interface SelectFieldProps {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
  hint?: string | undefined;
  disabled?: boolean | undefined;
}

/** A labelled native `<select>`. */
export function SelectField({
  label,
  value,
  onChange,
  children,
  hint,
  disabled,
}: SelectFieldProps) {
  const id = useId();
  const hintId = useId();
  return (
    <div className="clavis-field">
      <label className="clavis-label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="clavis-select"
        value={value}
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      {hint ? (
        <p id={hintId} className="clavis-hint">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
