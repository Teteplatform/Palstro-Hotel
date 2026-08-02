import { FieldShell, controlClasses, type BaseFieldProps } from './FieldShell';

interface TimeFieldProps extends BaseFieldProps {
  // 'HH:MM' (24-hour), or '' for empty. Native <input type="time"> speaks this
  // format regardless of whether the browser DISPLAYS a 12- or 24-hour clock.
  value: string;
  onChange: (value: string) => void;
}

// A time input sharing the same label / help / error shell and control styling as
// every other field, built once here for the same reason DateField was: reaching
// for a raw <input type="time"> per screen guarantees four different looks and
// four separate places to fix the next accessibility bug.
//
// Paired with DateField wherever an exact MOMENT is captured rather than a
// calendar day — the front desk recording when a guest actually arrived.
export function TimeField({ value, onChange, ...base }: TimeFieldProps) {
  return (
    <FieldShell {...base}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="time"
          value={value}
          onChange={(e) => onChange(e.target.value)}
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
