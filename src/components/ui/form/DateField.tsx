import { FieldShell, controlClasses, type BaseFieldProps } from './FieldShell';

interface DateFieldProps extends BaseFieldProps {
  // ISO yyyy-mm-dd, or '' for empty. Native <input type="date"> speaks this
  // format regardless of the browser's display locale.
  value: string;
  onChange: (value: string) => void;
  min?: string;
  max?: string;
}

// A date input sharing the same label / help / error shell and control styling as
// every other field (3.txt §4), so a date sits in a form identically to a text or
// select field. Built once here rather than reaching for a raw <input type="date">
// per screen.
export function DateField({ value, onChange, min, max, ...base }: DateFieldProps) {
  return (
    <FieldShell {...base}>
      {({ id, describedBy, invalid }) => (
        <input
          id={id}
          type="date"
          value={value}
          min={min}
          max={max}
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
