import type { ReactNode } from 'react';
import {
  TextField,
  TextArea,
  NumberField,
  CurrencyField,
  Select,
  Toggle,
  ColorField,
  StringListField,
} from '../../ui/form';
import type { SettingsField, SettingsValue, SettingsValues } from '../../../lib/settings/schema';
import { FONT_PAIRINGS } from '../../../lib/settings/fonts';
import { contrastRatio, isValidHex, AA_LARGE, AA_NORMAL } from '../../../lib/color';
import { osmEmbedSrc } from '../../../lib/osm';
import { ImageField } from './ImageField';
import { ImageListField } from './ImageListField';
import type { SettingsMediaContext } from './mediaFieldContext';

// The ONE place a field type maps to a control (build 3, §3). The SettingsForm
// renders <FieldControl> and never branches on type itself — all per-type
// handling is the switch below. The switch is exhaustive over SettingsField's
// `type` union, so adding a field type is a compile error here until it is
// handled, never a silently-unrendered field.

export interface FieldControlProps {
  field: SettingsField;
  value: SettingsValue;
  onChange: (value: SettingsValue) => void;
  error?: string;
  // The whole tab's values, so a colour field can check contrast against another
  // field's live value (background vs text).
  values: SettingsValues;
  // The property's currency code, for currency fields (no naira hardcode).
  currency: string;
  disabled?: boolean;
  // Media plumbing for the image / imageList renderers (build 4). Passed to EVERY
  // FieldControl uniformly; the non-image renderers ignore it, so SettingsForm
  // keeps its no-field-specific-branching rule. Absent only if a tab with image
  // fields is somehow rendered without it — the renderers guard for that.
  mediaContext?: SettingsMediaContext;
}

const FONT_OPTIONS = FONT_PAIRINGS.map((p) => ({ value: p.id, label: p.label }));

// A <select> can only show a value that is one of its options. If a row holds a
// value the curated list does not contain — a timezone or currency set before
// this list existed, one seeded straight into the DB, or one trimmed from the
// list later — the control would render the FIRST option instead, and the very
// next Save would write that first option over a value nobody chose to change.
//
// For timezone and currency that is not a cosmetic slip: it silently moves every
// business date, or re-denominates every price. So the stored value is appended
// as its own option, flagged so the admin can see it is off-list. Generic on
// purpose — it is a property of rendering a select against stored data, not a
// rule about any one field, so no per-field branch is needed here or later.
function withStoredValue(
  options: { value: string; label: string }[],
  stored: string,
): { value: string; label: string }[] {
  if (!stored || options.some((o) => o.value === stored)) return options;
  return [...options, { value: stored, label: `${stored} — current value` }];
}

export function FieldControl({
  field,
  value,
  onChange,
  error,
  values,
  currency,
  disabled,
  mediaContext,
}: FieldControlProps): ReactNode {
  const base = {
    label: field.label,
    helpText: field.help,
    error,
    required: field.required,
    disabled,
  };

  switch (field.type) {
    case 'text':
      return (
        <TextField
          {...base}
          value={asString(value)}
          onChange={onChange}
          placeholder={field.placeholder}
        />
      );

    case 'textarea':
      return (
        <TextArea
          {...base}
          value={asString(value)}
          onChange={onChange}
          placeholder={field.placeholder}
          rows={field.rows}
        />
      );

    case 'number':
      return (
        <NumberField
          {...base}
          value={asNumber(value)}
          onChange={onChange}
          placeholder={field.placeholder}
          min={field.min}
          max={field.max}
          step={field.step}
        />
      );

    case 'currency':
      return (
        <CurrencyField
          {...base}
          value={asNumber(value)}
          onChange={onChange}
          currency={currency}
          placeholder={field.placeholder}
        />
      );

    case 'select':
      return (
        <Select
          {...base}
          value={asString(value)}
          onChange={onChange}
          options={withStoredValue(field.options, asString(value))}
          placeholder={field.placeholder}
        />
      );

    case 'font':
      return (
        <Select
          {...base}
          value={asString(value)}
          onChange={onChange}
          options={FONT_OPTIONS}
        />
      );

    case 'toggle':
      return <Toggle {...base} value={Boolean(value)} onChange={onChange} />;

    case 'color':
      return (
        <ColorFieldWithContrast
          field={field}
          value={asString(value)}
          onChange={onChange}
          error={error}
          values={values}
          disabled={disabled}
        />
      );

    case 'stringList':
      return (
        <StringListField
          {...base}
          value={asStringArray(value)}
          onChange={onChange}
          placeholder={field.placeholder}
        />
      );

    case 'coordinateMap':
      // Presentational — reads its two sibling coordinate fields' live values and
      // renders the pin. No onChange: it never edits a value of its own.
      return <CoordinateMapField field={field} values={values} />;

    case 'image':
      // Persists immediately (upload replaces, remove deletes) — see ImageField.
      // Without media plumbing there is nothing to upload against, so fall back to
      // the informative placeholder rather than a broken control.
      return mediaContext ? (
        <ImageField field={field} ctx={mediaContext} disabled={disabled} />
      ) : (
        <ImagePlaceholder label={field.label} help={field.help} />
      );

    case 'imageList':
      return mediaContext ? (
        <ImageListField field={field} ctx={mediaContext} disabled={disabled} />
      ) : (
        <ImagePlaceholder label={field.label} help={field.help} />
      );
  }
}

// Colour field plus the WCAG contrast warning (§4). The warning is advisory, not
// blocking: it is the admin's brand, so a warning they can see beats a rule they
// cannot override. It sits below the field's own help/error row.
function ColorFieldWithContrast({
  field,
  value,
  onChange,
  error,
  values,
  disabled,
}: {
  field: Extract<SettingsField, { type: 'color' }>;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  values: SettingsValues;
  disabled?: boolean;
}) {
  const warning = contrastWarning(field, value, values);

  return (
    <div>
      <ColorField
        label={field.label}
        helpText={field.help}
        error={error}
        required={field.required}
        disabled={disabled}
        value={value}
        onChange={onChange}
      />
      {warning ? (
        <p role="status" className="mt-1 flex items-start gap-1 text-xs font-medium text-primary">
          <span aria-hidden="true">⚠</span>
          <span>{warning}</span>
        </p>
      ) : null}
    </div>
  );
}

function contrastWarning(
  field: Extract<SettingsField, { type: 'color' }>,
  value: string,
  values: SettingsValues,
): string | null {
  const c = field.contrast;
  if (!c) return null;
  if (!isValidHex(value)) return null; // nothing to judge yet

  const fg =
    c.foreground.kind === 'fixed'
      ? c.foreground.hex
      : asString(values[c.foreground.fieldKey]);
  if (!isValidHex(fg)) return null; // the paired colour isn't set — can't judge

  const ratio = contrastRatio(value, fg);
  if (ratio === null) return null;

  const threshold = c.largeText ? AA_LARGE : AA_NORMAL;
  if (ratio >= threshold) return null;

  return `Low contrast (${ratio.toFixed(1)}:1) with ${c.description}. Aim for at least ${threshold}:1 so it stays readable.`;
}

// Live OpenStreetMap pin preview for the coordinate fields (3.txt §3). It reads
// the two sibling number fields by key from the tab's live `values`, so the pin
// moves the moment either coordinate changes — the whole reason it sits beside the
// inputs: a plausible-but-wrong coordinate is invisible in the digits and obvious
// the instant the pin lands in the sea. Same keyless OSM embed as the guest site
// (shared osm helper), so preview and published map cannot diverge.
function CoordinateMapField({
  field,
  values,
}: {
  field: Extract<SettingsField, { type: 'coordinateMap' }>;
  values: SettingsValues;
}) {
  const rawLat = values[field.latKey];
  const rawLng = values[field.lngKey];
  const lat = typeof rawLat === 'number' ? rawLat : null;
  const lng = typeof rawLng === 'number' ? rawLng : null;
  const src = osmEmbedSrc(lat, lng);
  const bothEmpty = lat === null && lng === null;

  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-charcoal">
        {field.label}
      </span>
      {src ? (
        <div className="overflow-hidden rounded-xl border border-sand-border">
          <iframe
            title="Location pin preview"
            src={src}
            loading="lazy"
            className="block h-56 w-full border-0"
          />
        </div>
      ) : (
        <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-sand-border bg-sand/40 px-4 text-center text-xs text-charcoal-muted">
          {bothEmpty
            ? 'Enter a latitude and longitude above to preview the map pin.'
            : 'Enter valid coordinates to preview the pin — latitude −90 to 90, longitude −180 to 180.'}
        </div>
      )}
      {field.help ? (
        <p className="mt-1 text-xs text-charcoal-muted">{field.help}</p>
      ) : null}
    </div>
  );
}

function ImagePlaceholder({ label, help }: { label: string; help?: string }) {
  return (
    <div>
      <span className="mb-1 block text-sm font-medium text-charcoal">{label}</span>
      <div className="flex items-center justify-center rounded-lg border border-dashed border-sand-border bg-white/40 px-4 py-6 text-center text-xs text-charcoal-muted">
        Image editing is unavailable here right now.
      </div>
      {help ? <p className="mt-1 text-xs text-charcoal-muted">{help}</p> : null}
    </div>
  );
}

// --- narrowing helpers -----------------------------------------------------
// The value map is typed as the SettingsValue union; these narrow at the control
// boundary. onChange callbacks from the primitives already emit the right type,
// so the widened setter (SettingsValue) accepts them without a cast.
function asString(v: SettingsValue): string {
  return typeof v === 'string' ? v : '';
}
function asNumber(v: SettingsValue): number | null {
  return typeof v === 'number' ? v : null;
}
function asStringArray(v: SettingsValue): string[] {
  return Array.isArray(v) ? v : [];
}
