// The settings FIELD SCHEMA (build 3, §2).
//
// A settings surface is declared as DATA, not written as markup. Adding email
// templates in build 6 must be a schema entry here plus a tab in tabs.ts — never
// a new hand-built page. The generic SettingsForm renders whatever these
// declarations describe, and the save logic routes each value by the `storage`
// it carries. A future reader must be able to see WHERE a value lands and HOW it
// is validated without tracing the save code — so both live on the field.

import type { SelectOption } from '../../components/ui/form';
import type { MediaCategory } from '../../types/media';

// ---------------------------------------------------------------------------
// Field value types
// ---------------------------------------------------------------------------
// The union of every shape a field's value can take, keyed off its type below.
// text/textarea/select/color/font -> string; number/currency -> number | null
// (null models "empty", never a silent 0); toggle -> boolean; stringList /
// imageList -> string[]; image -> string | null.
export type SettingsValue = string | number | boolean | string[] | null;

// A whole tab's worth of values, keyed by field.key (NOT by storage column — one
// tab can hold two fields that map to columns of the same name in different
// tables, so the field key is the stable handle).
export type SettingsValues = Record<string, SettingsValue>;

// ---------------------------------------------------------------------------
// Storage targets — WHERE a value lands
// ---------------------------------------------------------------------------
// Settings live in three tables and, within one of them, a JSONB column — four
// distinct destinations. Making the target explicit on every field is the whole
// point: the save code splits changed values by target and calls the matching
// migration-008 RPC for each, and a reader sees the destination at a glance.
//
//   properties        -> a column on the properties row        (timezone, phone)
//   property_settings -> a column on the property_settings row (template, booking_enabled)
//   branding          -> a key inside property_settings.branding JSONB (colours, tagline)
//   tenant_settings   -> a column on the tenant_settings row    (default_vat_rate)
export type FieldStorage =
  | { target: 'properties'; column: string }
  | { target: 'property_settings'; column: string }
  | { target: 'branding'; brandingKey: string }
  | { target: 'tenant_settings'; column: string };

// The four RPC-routable tables (branding writes through the property_settings
// row too, but via a different RPC, so it is tracked separately downstream).
export type StorageTargetName = FieldStorage['target'];

// ---------------------------------------------------------------------------
// Field types
// ---------------------------------------------------------------------------
export type FieldType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'currency'
  | 'select'
  | 'toggle'
  | 'color'
  | 'font'
  | 'stringList'
  | 'image'
  | 'imageList';

// ---------------------------------------------------------------------------
// Validation — HOW a value is checked, declared alongside the field
// ---------------------------------------------------------------------------
// `required` lives on the field itself (the brief lists it separately); these
// are the ADDITIONAL rules. `validate` is an escape hatch for cross-field rules
// (it receives the whole tab's values). All run before save; any error blocks
// the save and shows on the field (§3).
export interface FieldValidation {
  min?: number;
  max?: number;
  // Applied to string-typed values only.
  pattern?: RegExp;
  patternMessage?: string;
  // Return an error string to reject, or null to accept. Sees sibling values so
  // it can express "must match X" style rules.
  validate?: (value: SettingsValue, all: SettingsValues) => string | null;
}

// The foreground that will visually sit ON a colour, so the field can warn when
// the pairing fails WCAG AA (§4 contrast validation). Either a fixed colour
// (e.g. white button text on the primary) or another field's live value (e.g.
// the text colour that will sit on the background the admin is editing).
export type ContrastForeground =
  | { kind: 'fixed'; hex: string }
  | { kind: 'field'; fieldKey: string };

export interface ColorContrast {
  foreground: ContrastForeground;
  // AA is 3:1 for large text, 4.5:1 for normal. Default (undefined) = normal.
  largeText?: boolean;
  // Human phrasing for the warning, e.g. "white button text".
  description: string;
}

// ---------------------------------------------------------------------------
// The field declaration
// ---------------------------------------------------------------------------
// A base plus a per-type extension. The union discriminates on `type` so the
// renderer map (fieldRenderers.tsx) and the value (de)serialisers can switch on
// it exhaustively — and so a field can only carry the extra props its type
// actually uses (a `select` has options, a `color` has contrast, a plain `text`
// has neither).
interface BaseField {
  // Unique within its tab; also the key under which this field's value is held
  // in SettingsValues.
  key: string;
  label: string;
  help?: string;
  required?: boolean;
  storage: FieldStorage;
  validation?: FieldValidation;
  // The value a field starts from when NOTHING is stored yet (an absent branding
  // key, most often). Section-visibility toggles default true (a section shows
  // unless hidden); everything else falls back to the type's empty value.
  defaultValue?: SettingsValue;
}

export type SettingsField =
  | (BaseField & {
      type: 'text' | 'textarea';
      placeholder?: string;
      rows?: number;
    })
  | (BaseField & {
      type: 'number';
      min?: number;
      max?: number;
      step?: number;
      placeholder?: string;
      // For a column stored as a fraction but edited as a percentage (VAT is
      // 0.075 in the DB, 7.5 in the field): value_in_db = value_in_field * scale.
      // Applied uniformly by the (de)serialisers — never a per-field branch.
      scale?: number;
    })
  | (BaseField & { type: 'currency'; placeholder?: string })
  | (BaseField & {
      type: 'select';
      options: SelectOption[];
      placeholder?: string;
    })
  | (BaseField & { type: 'toggle' })
  | (BaseField & { type: 'color'; contrast?: ColorContrast })
  | (BaseField & { type: 'font' })
  | (BaseField & { type: 'stringList'; placeholder?: string })
  | (BaseField & {
      type: 'image' | 'imageList';
      // Which media_assets category uploads from this field are filed under, so
      // the bucket path and the row's category are correct (no literal in the
      // component — rule 17). logo/about are single 'image' fields; hero/gallery
      // are 'imageList'.
      mediaCategory: MediaCategory;
      // The most images an imageList may hold, declared in the schema rather than
      // hardcoded in the renderer (build 4 §1): 5 for hero (3.txt §5), 30 for
      // gallery. Ignored for a single 'image' field.
      max?: number;
    });

// The image-bearing field member (image + imageList share one union member, so
// this is the single type both the ImageField and ImageListField renderers take).
export type ImageSettingsField = Extract<
  SettingsField,
  { type: 'image' | 'imageList' }
>;

// A tab is a titled group of fields. `module` is unused today (Settings is
// always enabled) but reserved so a future tab can be gated like a nav module.
export interface SettingsTab {
  id: string;
  label: string;
  description?: string;
  fields: SettingsField[];
}

// The default value a field starts from before any DB value is loaded — used so
// the form's value map is always fully populated (never `undefined`), which
// keeps every control a controlled input.
export function emptyValueFor(field: SettingsField): SettingsValue {
  switch (field.type) {
    case 'number':
    case 'currency':
      return null;
    case 'toggle':
      return false;
    case 'stringList':
    case 'imageList':
      return [];
    case 'image':
      return null;
    default:
      // text, textarea, select, color, font
      return '';
  }
}
