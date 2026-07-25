// Field/tab validation (build 3, §3). Runs before every save; any error blocks
// the save and renders on the offending field. Rules are keyed off each field's
// declared `type`, `required` and `validation` — no per-field branching, so a
// new field is validated the moment it is added to a tab.

import { isValidHex } from '../color';
import type {
  SettingsField,
  SettingsValue,
  SettingsValues,
} from './schema';

// True when a value counts as "empty" for the required check — per type, so an
// empty string, a null number, and an empty list are all caught.
function isEmpty(field: SettingsField, value: SettingsValue): boolean {
  switch (field.type) {
    case 'number':
    case 'currency':
    case 'image':
      return value === null || value === undefined;
    case 'toggle':
      return false; // a boolean is never "empty"
    case 'stringList':
    case 'imageList':
      return !Array.isArray(value) || value.length === 0;
    default:
      return typeof value !== 'string' || value.trim().length === 0;
  }
}

// Validate one field. Returns an error string, or null when it passes.
export function validateField(
  field: SettingsField,
  value: SettingsValue,
  all: SettingsValues,
): string | null {
  const empty = isEmpty(field, value);

  if (field.required && empty) return `${field.label} is required.`;

  // A colour that is present must be a real hex; blank is allowed (falls back to
  // the platform default). This is the type-keyed rule, not a per-field one.
  if (field.type === 'color' && !empty) {
    if (typeof value !== 'string' || !isValidHex(value)) {
      return 'Enter a colour as #RGB or #RRGGBB.';
    }
  }

  const rules = field.validation;
  if (rules) {
    if (
      rules.pattern &&
      typeof value === 'string' &&
      value.trim().length > 0 &&
      !rules.pattern.test(value.trim())
    ) {
      return rules.patternMessage ?? `${field.label} is not in the right format.`;
    }

    if (rules.validate) {
      const custom = rules.validate(value, all);
      if (custom) return custom;
    }
  }

  // Numeric bounds: a number field carries min/max directly; either kind may
  // also set them via validation. Check both, once.
  if (
    (field.type === 'number' || field.type === 'currency') &&
    typeof value === 'number'
  ) {
    const min =
      field.type === 'number' ? (field.min ?? rules?.min) : rules?.min;
    const max =
      field.type === 'number' ? (field.max ?? rules?.max) : rules?.max;
    if (min !== undefined && value < min) {
      return `${field.label} must be at least ${min}.`;
    }
    if (max !== undefined && value > max) {
      return `${field.label} must be at most ${max}.`;
    }
  }

  return null;
}

// Validate every field on a tab. Returns a map of field.key -> error message for
// the fields that failed (empty when the tab is valid).
export function validateTab(
  fields: SettingsField[],
  values: SettingsValues,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    if (field.type === 'image' || field.type === 'imageList') continue; // deferred
    if (field.type === 'coordinateMap') continue; // presentational — no value
    const err = validateField(field, values[field.key], values);
    if (err) errors[field.key] = err;
  }
  return errors;
}
