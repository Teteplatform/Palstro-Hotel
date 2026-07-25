import { SETTINGS_TABS } from './tabs';
import type { SettingsField, SettingsTab } from './schema';

// A flat index of every settings field by its key, across ALL tabs. The inline
// Site editor (3.txt) addresses fields by key — a region like the Hero edits
// `hero_images`, `tagline` and `name`, which live on DIFFERENT tabs — so it needs
// to resolve an arbitrary key set without caring which tab each came from. Built
// once from the same SETTINGS_TABS the form renders, so the editor and the form
// share one schema (a field that renders one way here and another there would be
// a bug — there is only one source).
const FIELD_BY_KEY: Map<string, SettingsField> = new Map(
  SETTINGS_TABS.flatMap((tab) => tab.fields).map((f) => [f.key, f]),
);

// Resolve an ordered list of field keys to their field declarations, dropping any
// key with no match (defensive — a region should only name real keys). Order is
// preserved so the panel renders controls in the order the region declared.
export function fieldsForKeys(keys: string[]): SettingsField[] {
  return keys
    .map((k) => FIELD_BY_KEY.get(k))
    .filter((f): f is SettingsField => f !== undefined);
}

// Wrap a resolved field set as a synthetic "tab" so the existing values helpers
// (initialValues, changedFieldKeys, buildPatches, validateTab via .fields) work
// unchanged over an editor region — no per-field branching, exactly as the form.
export function regionTab(label: string, keys: string[]): SettingsTab {
  return { id: 'region', label, fields: fieldsForKeys(keys) };
}

// The theme region: colours and the font pairing. Not a region on the page — it
// applies to everything and belongs to no single section (3.txt §2), so the
// floating Theme control opens exactly these keys.
export const THEME_FIELD_KEYS = [
  'primary_color',
  'background_color',
  'text_color',
  'surface_color',
  'accent_color',
  'font_pairing',
];
