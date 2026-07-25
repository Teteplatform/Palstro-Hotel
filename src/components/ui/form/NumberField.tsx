import { useState } from 'react';
import { FieldShell, controlClasses, type BaseFieldProps } from './FieldShell';
import { parseNumeric } from '../../../lib/format';

interface NumberFieldProps extends BaseFieldProps {
  // null models "empty" — a number input with no value entered. Callers get a
  // real null, not a silent 0 (parseNumeric guards Number('') === 0).
  value: number | null;
  onChange: (value: number | null) => void;
  placeholder?: string;
  min?: number;
  max?: number;
  // 'any' allows arbitrary decimals (coordinates); a number restricts the spinner.
  step?: number | 'any';
}

export function NumberField({
  value,
  onChange,
  placeholder,
  min,
  max,
  step,
  ...base
}: NumberFieldProps) {
  // Keep a text draft so partial input ('', '-', '1.') is editable without the
  // parent's numeric value fighting the keystrokes. We emit the parsed number
  // (or null) upward on every change, but render from the draft.
  const [draft, setDraft] = useState(value === null ? '' : String(value));

  // Re-sync the draft when `value` is changed from OUTSIDE (e.g. a form reset),
  // but not when it merely echoes what the user just typed. This is React's
  // "adjust state during render when a prop changes" pattern — a conditional
  // setState in render, not an effect, so there is no cascading re-render.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    // Only overwrite the draft if it no longer represents the incoming value
    // (so typing '1.' — which parses to 1 — is left intact).
    if (parseNumeric(draft) !== value) {
      setDraft(value === null ? '' : String(value));
    }
  }

  return (
    <FieldShell {...base}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="number"
          inputMode="decimal"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            onChange(parseNumeric(e.target.value));
          }}
          placeholder={placeholder}
          min={min}
          max={max}
          step={step}
          required={base.required}
          disabled={base.disabled}
          aria-describedby={describedBy}
          aria-invalid={invalid || undefined}
          className={controlClasses}
        />
      )}
    </FieldShell>
  );
}
