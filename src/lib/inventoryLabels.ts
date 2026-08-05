import type { ItemType, LocationKind, UnitDimension } from '../types/inventory';

// Generic UI copy for the inventory enums — no tenant content (rule 17), just
// the human labels and the plain-language hints for the DB's item_type,
// location kind and unit dimension values. Defined once so the item form, the
// list badges and the locations screen all describe a type the same way.
//
// The HINTS matter more than usual here. "raw / finished / both" is the one
// choice an owner setting up the catalogue can get wrong in a way that only
// surfaces months later as stock that never deducts, so each option explains
// itself in the form rather than assuming the word is self-evident.

// ---------------------------------------------------------------------------
// Item types
// ---------------------------------------------------------------------------

const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  raw: 'Ingredient',
  finished: 'Sold as-is',
  both: 'Both',
};

export function itemTypeLabel(type: ItemType): string {
  return ITEM_TYPE_LABELS[type] ?? type;
}

const ITEM_TYPE_HINTS: Record<ItemType, string> = {
  raw: 'Used up by recipes only — never sold on its own. Rice, cooking oil, soap.',
  finished:
    'Sold exactly as it is. One sale takes one unit off the shelf. Bottled water, biscuits.',
  both: 'Sold on its own AND used in recipes — a 50cl Coke sold at the bar and poured into a cocktail.',
};

export function itemTypeHint(type: ItemType): string {
  return ITEM_TYPE_HINTS[type] ?? '';
}

// The types a filter or a picker offers, in the order they read best.
export const ITEM_TYPES: ItemType[] = ['raw', 'finished', 'both'];

// A tone token per type so the list badges read consistently. Design tokens
// only, never a literal hex (rule 17 / §8).
export function itemTypeTone(type: ItemType): string {
  switch (type) {
    case 'finished':
      return 'bg-accent/15 text-accent';
    case 'both':
      return 'bg-primary/10 text-primary';
    case 'raw':
    default:
      return 'bg-sand text-charcoal-muted';
  }
}

// ---------------------------------------------------------------------------
// Location kinds
// ---------------------------------------------------------------------------

const LOCATION_KIND_LABELS: Record<LocationKind, string> = {
  store: 'Store',
  kitchen: 'Kitchen',
  bar: 'Bar',
  housekeeping: 'Housekeeping',
  other: 'Other',
};

export function locationKindLabel(kind: LocationKind): string {
  return LOCATION_KIND_LABELS[kind] ?? kind;
}

// What each kind will DO once movements exist (part 2/3). Written as a promise
// about behaviour, not a definition of the word, because that is the part the
// person choosing it needs to predict.
const LOCATION_KIND_HINTS: Record<LocationKind, string> = {
  store:
    'Holds bulk stock and issues it to the other locations. Deliveries are received in here.',
  kitchen:
    'Uses up stock through recipes — a plated dish takes its ingredients out of this kitchen.',
  bar: 'Sells drinks straight off the shelf and pours recipes for cocktails.',
  housekeeping:
    'Stocks the rooms. Issuing an amenity kit while cleaning takes it off this location.',
  other:
    'Anything else that holds stock — a maintenance cupboard, laundry chemicals. Holds and issues only.',
};

export function locationKindHint(kind: LocationKind): string {
  return LOCATION_KIND_HINTS[kind] ?? '';
}

export const LOCATION_KINDS: LocationKind[] = [
  'store',
  'kitchen',
  'bar',
  'housekeeping',
  'other',
];

export function locationKindTone(kind: LocationKind): string {
  switch (kind) {
    case 'store':
      return 'bg-primary/10 text-primary';
    case 'kitchen':
      return 'bg-accent/15 text-accent';
    case 'bar':
      return 'bg-accent/15 text-accent';
    case 'housekeeping':
    case 'other':
    default:
      return 'bg-sand text-charcoal-muted';
  }
}

// ---------------------------------------------------------------------------
// Unit dimensions
// ---------------------------------------------------------------------------

const UNIT_DIMENSION_LABELS: Record<UnitDimension, string> = {
  mass: 'Weight',
  volume: 'Volume',
  count: 'Count',
  length: 'Length',
};

export function unitDimensionLabel(dimension: UnitDimension): string {
  return UNIT_DIMENSION_LABELS[dimension] ?? dimension;
}
