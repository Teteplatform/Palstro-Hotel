// Value plumbing between the DB rows and the form (build 3, §3). Keeps the
// SettingsForm free of any per-field branching: it reads baselines, detects what
// changed, and builds the per-table patches through these helpers, all driven by
// each field's `type` and `storage` declaration.

import { parseNumeric } from '../format';
import type {
  Property,
  PropertyFinanceSettings,
  PropertySettings,
  TenantSettings,
} from '../../types/tenant';
import { emptyValueFor, type SettingsField, type SettingsTab } from './schema';
import type { SettingsValue, SettingsValues } from './schema';

// The four rows a settings surface reads from — loaded together in one pass.
export interface SettingsRows {
  property: Property;
  settings: PropertySettings;
  tenant: TenantSettings;
  // Per-property INTERNAL finance config (021 §3) — the discount threshold. A
  // separate row because property_settings is publicly readable and RLS cannot
  // hide a column; guaranteed to exist by an AFTER INSERT trigger, so this is
  // never optional.
  finance: PropertyFinanceSettings;
}

// Round away binary-float noise introduced by the scale conversion (a
// fraction<->percent divide/multiply) so 0.075 / 0.01 reads as 7.5, not
// 7.499999999999999.
function tidy(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

// The raw value straight out of whichever row/column/JSONB key the field points
// at, before any type conversion. `undefined` for an absent branding key.
function readRaw(field: SettingsField, rows: SettingsRows): unknown {
  const s = field.storage;
  if (!s) return undefined; // presentational field (coordinateMap) — no source
  switch (s.target) {
    case 'properties':
      return (rows.property as unknown as Record<string, unknown>)[s.column];
    case 'property_settings':
      return (rows.settings as unknown as Record<string, unknown>)[s.column];
    case 'tenant_settings':
      return (rows.tenant as unknown as Record<string, unknown>)[s.column];
    case 'property_finance_settings':
      return (rows.finance as unknown as Record<string, unknown>)[s.column];
    case 'branding':
      return (rows.settings.branding as Record<string, unknown>)?.[s.brandingKey];
  }
}

// Convert the raw DB value into the field's in-form value type. When the stored
// value is absent, fall back to the field's declared default, then to the
// type's empty value — so every control is always controlled.
export function fieldBaselineValue(
  field: SettingsField,
  rows: SettingsRows,
): SettingsValue {
  const raw = readRaw(field, rows);
  const fallback = field.defaultValue ?? emptyValueFor(field);

  switch (field.type) {
    case 'number':
    case 'currency': {
      // numeric columns arrive as strings from PostgREST — parse explicitly.
      const n = parseNumeric(raw as string | number | null | undefined);
      if (n === null) return fallback;
      const scale = field.type === 'number' ? field.scale : undefined;
      return scale ? tidy(n / scale) : n;
    }
    case 'toggle':
      return typeof raw === 'boolean' ? raw : fallback;
    case 'stringList':
    case 'imageList':
      return Array.isArray(raw)
        ? raw.filter((x): x is string => typeof x === 'string')
        : fallback;
    case 'image':
      return typeof raw === 'string' ? raw : fallback;
    default:
      // text, textarea, select, color, font
      if (typeof raw === 'string') return raw;
      if (raw === null || raw === undefined) return fallback;
      return String(raw);
  }
}

// Initial value map for a whole tab, keyed by field.key.
export function initialValues(
  tab: SettingsTab,
  rows: SettingsRows,
): SettingsValues {
  const out: SettingsValues = {};
  for (const field of tab.fields) out[field.key] = fieldBaselineValue(field, rows);
  return out;
}

// Order-sensitive equality (section_order cares about order; a set of chips does
// not, but treating both as ordered is correct for either).
export function valuesEqual(a: SettingsValue, b: SettingsValue): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  return a === b;
}

// The keys of fields whose current value differs from the loaded baseline. Image
// fields are deferred (disabled placeholders), so they never register a change.
export function changedFieldKeys(
  tab: SettingsTab,
  values: SettingsValues,
  rows: SettingsRows,
): string[] {
  return tab.fields
    .filter(
      (f) =>
        f.type !== 'image' &&
        f.type !== 'imageList' &&
        f.type !== 'coordinateMap', // presentational — never a changed value
    )
    .filter((f) => !valuesEqual(values[f.key], fieldBaselineValue(f, rows)))
    .map((f) => f.key);
}

// The DB/RPC representation of a single field's in-form value. Reverses the
// baseline conversion (re-applies scale, leaves everything else as its JSON
// primitive). Never called for image fields.
function serializeField(field: SettingsField, value: SettingsValue): unknown {
  switch (field.type) {
    case 'number': {
      if (value === null) return null;
      const n = value as number;
      return field.scale ? tidy(n * field.scale) : n;
    }
    case 'currency':
      return value; // number | null
    case 'toggle':
      return Boolean(value);
    case 'stringList':
      return Array.isArray(value) ? value : [];
    default:
      // text, textarea, select, color, font
      return typeof value === 'string' ? value : '';
  }
}

// The five per-destination patches for a save, each present only if it has at
// least one changed field. branding + config both write the property_settings
// row (via different RPCs) and so share its updated_at token downstream.
export interface SettingsPatches {
  branding?: Record<string, unknown>;
  config?: Record<string, unknown>; // property_settings columns
  properties?: Record<string, unknown>;
  tenant?: Record<string, unknown>;
  finance?: Record<string, unknown>; // property_finance_settings columns
}

export function buildPatches(
  tab: SettingsTab,
  values: SettingsValues,
  changedKeys: string[],
): SettingsPatches {
  const patches: SettingsPatches = {};
  const changed = new Set(changedKeys);

  for (const field of tab.fields) {
    if (!changed.has(field.key)) continue;
    const s = field.storage;
    if (!s) continue; // presentational field — nothing to persist
    const serialized = serializeField(field, values[field.key]);

    switch (s.target) {
      case 'branding':
        (patches.branding ??= {})[s.brandingKey] = serialized;
        break;
      case 'property_settings':
        (patches.config ??= {})[s.column] = serialized;
        break;
      case 'properties':
        (patches.properties ??= {})[s.column] = serialized;
        break;
      case 'tenant_settings':
        (patches.tenant ??= {})[s.column] = serialized;
        break;
      case 'property_finance_settings':
        (patches.finance ??= {})[s.column] = serialized;
        break;
    }
  }

  return patches;
}

// Build the branding-shaped object the theme preview consumes from the tab's
// live colour/font values (keyed by branding key, as applyBranding expects).
export function brandingPreviewFrom(
  tab: SettingsTab,
  values: SettingsValues,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of tab.fields) {
    if (field.storage?.target !== 'branding') continue;
    if (field.type === 'color' || field.type === 'font') {
      out[field.storage.brandingKey] = values[field.key];
    }
  }
  return out;
}
