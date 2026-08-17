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
  reversal: 'Reversal',
};

export function movementTypeLabel(type: MovementType): string {
  return MOVEMENT_TYPE_LABELS[type] ?? type;
}

// A tone token per type. Design tokens only, never a literal hex (rule 17 / §8).
// Adjustments deliberately read as the loudest of the three that exist today:
// they are the movement with no purchase and no sale behind them, and they
// should catch the eye of anyone scanning a ledger.
//
// A REVERSAL GETS ITS OWN TONE, distinct from an adjustment, for the same reason
// 038 gave it its own movement_type: someone scanning a month of movements for
// the unexplained ones must be able to tell a correction of a legitimate posting
// from stock that moved with nothing behind it. If the two looked alike here,
// the type would be doing its job in the database and not on the screen.
export function movementTypeTone(type: MovementType): string {
  switch (type) {
    case 'opening':
      return 'bg-primary/10 text-primary';
    case 'adjustment':
    case 'count_adjustment':
    case 'wastage':
      return 'bg-accent/15 text-accent';
    case 'reversal':
      return 'bg-primary/15 text-primary ring-1 ring-inset ring-primary/30';
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

// STOCK_COUNT_POSTING_NOTE lived here until 039 and has been DELETED rather than
// updated, because every word of it is now false. It said a count posted its
// differences as ordinary ADJUSTMENTS, and that the dedicated count movement
// type was reserved with no way to be written — both true of 036/038 and both
// untrue the moment finish_stock_take shipped. A stale caveat is worse than no
// caveat: it teaches the reader something the system stopped doing, and nothing
// errors while it does.
//
// The count's own copy now lives in stockTakeLabels.ts, beside the screen that
// says it.

export const IMPORT_HISTORY_NOTE =
  'Spreadsheet loads record opening balances, and that is what is listed here — ' +
  'every opening balance on file, newest first, with who loaded it and when. A ' +
  'per-file log (this file, these rows, these failures) needs a record of its ' +
  'own and arrives with purchasing.';

// ---------------------------------------------------------------------------
// 038's behaviour, explained where people meet it
// ---------------------------------------------------------------------------
//
// NOTHING IN THIS SECTION RESTATES A RULE THE DATABASE ENFORCES. Every refusal
// message a user sees comes from the server verbatim (stockErrorMessage, which
// now appends the RAISE hint too). These strings explain what a control DOES
// before it is used — which is the client's job — and stop where the server's
// job starts.

export const REVERSAL_POSTS_TODAY_NOTE =
  'The reversal is dated today, not the day of the original. Yesterday’s stock ' +
  'report stays exactly as it was printed, and the correction appears on the day ' +
  'it was actually made — the same rule the folio follows.';

export const REVERSAL_PERMANENCE_NOTE =
  'Nothing is deleted. The original movement stays exactly as it was recorded ' +
  'and a matching opposite movement is posted beside it, so both the mistake and ' +
  'the correction stay visible with their own names against them.';

// What a negative position means, in the words the screen uses. Framed as a
// question because that is what it is.
export const NEGATIVE_STOCK_EXPLANATION =
  'A negative means stock left without a movement behind it: a delivery that ' +
  'was never entered, an issue posted against the wrong location, or stock that ' +
  'walked. It is a question worth asking, not a fault in the system — and it is ' +
  'never rounded up to zero, because hiding it would hide the very thing worth ' +
  'looking at.';

export const NEGATIVE_STOCK_TOTAL_EXPLANATION =
  'Covers the whole filtered set, across all pages — not just this page. The ' +
  'value is negative because the quantity is: it is what the missing stock would ' +
  'have been worth at the location’s average cost.';

// The distinction between the two places a negative can be seen, stated on the
// page rather than left to memory. Shown on the Products tab beside its
// negative filter, pointing at the screen that can see more.
export const NEGATIVE_FILTER_CROSS_REFERENCE =
  'A negative sitting behind an item or location that has been REMOVED does not ' +
  'appear here — the Negative Stock tab lists those as well, and shows which ' +
  'positions cannot be corrected until something is switched back on.';

export const NEGATIVE_UNCORRECTABLE_NOTE =
  'Stock cannot be recorded against a location or an item that is switched off ' +
  'or removed, so this position cannot be corrected until it is switched back on.';

// What turning on batch tracking commits the storekeeper to. Deliberately worded
// as the WORK it creates rather than as a property of the goods — "perishable"
// is a different field with a different meaning and no consequences attached.
export const TRACKS_EXPIRY_EXPLANATION =
  'Every delivery of this item must record a batch code and an expiry date. ' +
  'Turn it on for anything you would need to trace or recall — milk, medicines, ' +
  'packaged food with a date on the box. This is different from “perishable”, ' +
  'which only describes the goods; this one adds two required fields every time ' +
  'stock comes in.';

export const BATCH_FIELDS_IN_ONLY_NOTE =
  'Batch and expiry are recorded when stock comes IN. They are not asked for ' +
  'when stock goes out: which batch left is decided by the issue rules, not ' +
  'typed in here.';

// Why an adjustment demands a reason, shown on the form itself rather than
// discovered as a validation error.
export const ADJUSTMENT_REASON_EXPLANATION =
  'An adjustment changes stock with no purchase and no sale behind it, so the ' +
  'reason and your name are recorded permanently against it. It cannot be ' +
  'edited or deleted afterwards — a mistake is corrected with another ' +
  'adjustment, so the whole story stays visible.';
