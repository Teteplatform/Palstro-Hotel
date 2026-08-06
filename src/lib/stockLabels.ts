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

// Why an adjustment demands a reason, shown on the form itself rather than
// discovered as a validation error.
export const ADJUSTMENT_REASON_EXPLANATION =
  'An adjustment changes stock with no purchase and no sale behind it, so the ' +
  'reason and your name are recorded permanently against it. It cannot be ' +
  'edited or deleted afterwards — a mistake is corrected with another ' +
  'adjustment, so the whole story stays visible.';
