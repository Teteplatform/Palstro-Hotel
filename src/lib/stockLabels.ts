import type { MovementType } from '../types/stock';

// Generic UI copy for the movement ledger — no tenant content (rule 17), just
// the human labels and tone tokens for the DB's movement_type values, plus the
// words the stock screens use for the two figures people most often misread.
//
// Defined once so the ledger, the badges and the forms describe a movement the
// same way. Same shape as inventoryLabels.ts.

// ---------------------------------------------------------------------------
// Movement types
// ---------------------------------------------------------------------------

const MOVEMENT_TYPE_LABELS: Record<MovementType, string> = {
  opening: 'Opening balance',
  adjustment: 'Adjustment',
  receipt: 'Received',
  issue_out: 'Issued out',
  issue_in: 'Issued in',
  transfer_out: 'Transferred out',
  transfer_in: 'Transferred in',
  consumption: 'Used by sales',
  wastage: 'Wastage',
  count_adjustment: 'Count correction',
};

export function movementTypeLabel(type: MovementType): string {
  return MOVEMENT_TYPE_LABELS[type] ?? type;
}

// A tone token per type. Design tokens only, never a literal hex (rule 17 / §8).
// Adjustments deliberately read as the loudest of the three that exist today:
// they are the movement with no purchase and no sale behind them, and they
// should catch the eye of anyone scanning a ledger.
export function movementTypeTone(type: MovementType): string {
  switch (type) {
    case 'opening':
      return 'bg-primary/10 text-primary';
    case 'adjustment':
    case 'count_adjustment':
    case 'wastage':
      return 'bg-accent/15 text-accent';
    default:
      return 'bg-sand text-charcoal-muted';
  }
}

// ---------------------------------------------------------------------------
// The two explanations this module keeps having to give
// ---------------------------------------------------------------------------

// Rule 16, applied to the figure this whole tranche exists to produce. Used as
// the tooltip on the location's total and repeated wherever a value is shown.
export const STOCK_VALUE_EXPLANATION =
  'Covers the whole filtered set, across all pages — not just this page. ' +
  'Each item is valued at its quantity on hand × its moving average cost in ' +
  'this location, and the quantity is the sum of every movement recorded ' +
  'against it here. Nothing is stored: both figures are recomputed from the ' +
  'movements every time this screen loads.';

// What "moving average cost" means, in the words a hotel owner uses. Shown
// beside the cost column and on the adjustment form.
export const MOVING_AVERAGE_EXPLANATION =
  'Every time stock comes in at a new price, the cost of what you already had ' +
  'and the cost of what just arrived are blended in proportion to their ' +
  'quantities. Taking stock out never changes it — it leaves at the average ' +
  'that is already there.';

// The consolidated inventory page shows four figures above its list, and three
// of them are routinely misread. Each carries its own note (rule 16), and each
// note also states that the figure covers the WHOLE FILTERED SET (rule 20).

export const ITEM_COUNT_EXPLANATION =
  'Every item in your catalogue matching the current filters, across all pages ' +
  '— including items holding nothing right now. Items switched off are left out ' +
  'unless you ask for them.';

export const ITEMS_WITH_STOCK_EXPLANATION =
  'How many of those items are holding something other than zero at the ' +
  'location shown, across the whole filtered set. An item held in two locations ' +
  'is counted once.';

// The honest caveat on the one ERP figure that does not survive translation to a
// hotel. The ERP sells packaged goods counted in pieces; a hotel measures rice
// in kilograms, oil in litres and beer in bottles, and adding those together is
// arithmetic without a unit. It is still shown, because a rough sense of scale
// is what people look for — but it says what it is.
export const TOTAL_UNITS_EXPLANATION =
  'Adds every item’s quantity together across the whole filtered set — ' +
  'kilograms, litres and bottles in one number. It is a rough sense of scale, ' +
  'not a measurable total: the stock value beside it is the figure that really ' +
  'adds up.';

// The two tabs that do less than their name suggests say so on the tab itself,
// in the same words used in the build notes, so nobody discovers the limit by
// finding a number missing.

export const STOCK_COUNT_POSTING_NOTE =
  'A count posts each difference as an ADJUSTMENT, with the count and its date ' +
  'as the reason. The dedicated “count” movement type is reserved for the stock ' +
  'count tranche and has no way to be written yet, so nothing here pretends to ' +
  'be one — every line you post is a normal adjustment, permanent and in your ' +
  'name.';

export const IMPORT_HISTORY_NOTE =
  'Spreadsheet loads record opening balances, and that is what is listed here — ' +
  'every opening balance on file, newest first, with who loaded it and when. A ' +
  'per-file log (this file, these rows, these failures) needs a record of its ' +
  'own and arrives with purchasing.';

// Why an adjustment demands a reason, shown on the form itself rather than
// discovered as a validation error.
export const ADJUSTMENT_REASON_EXPLANATION =
  'An adjustment changes stock with no purchase and no sale behind it, so the ' +
  'reason and your name are recorded permanently against it. It cannot be ' +
  'edited or deleted afterwards — a mistake is corrected with another ' +
  'adjustment, so the whole story stays visible.';
