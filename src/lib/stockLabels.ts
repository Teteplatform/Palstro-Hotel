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

// ---------------------------------------------------------------------------
// Cost and retail, side by side (1.1e §2)
// ---------------------------------------------------------------------------
// THE TWO FIGURES ARE LABELLED SO THEY CAN NEVER BE CONFUSED, because confusing
// them is expensive in both directions: a retail figure read as the stock's worth
// overstates the balance sheet, and a cost figure read as what the shelf will
// bring in understates every margin decision made from it. Hence "Value at cost"
// and "Retail value" as words on the tiles, and these notes underneath.

// STOCK_VALUE_EXPLANATION above still describes the cost figure and is unchanged;
// this is the sentence the tile adds now that there is something beside it to be
// distinguished from.
export const COST_VALUE_CONTRAST =
  'This is what the books say your stock is worth — what you actually paid for ' +
  'it. The retail figure beside it is what it would bring in if you sold it.';

export const RETAIL_VALUE_EXPLANATION =
  'What this stock would bring in at your own selling prices, BEFORE tax, ' +
  'across the whole filtered set and not just this page. Each item is counted ' +
  'at its quantity on hand × its selling price. Items with no selling price are ' +
  'left out entirely — the tile says how many — because there is no price to ' +
  'value them at, and counting them as nothing would quietly shrink the total.';

// THE ONE THAT NEEDS THE MOST CARE, because the obvious reading of it is wrong.
// Margin is retail minus the cost of THE SAME items — not minus the value-at-cost
// tile, which also covers every ingredient in the store. Said plainly, because an
// owner WILL try to subtract the two tiles and needs to know why the answer
// differs.
export const MARGIN_EXPLANATION =
  'Retail value minus what those same items cost you — only the items that have ' +
  'a selling price, on both sides. It is deliberately NOT the retail tile minus ' +
  'the cost tile: the cost tile includes your ingredients, which have no selling ' +
  'price, so subtracting it would count every sack of rice in the store as a ' +
  'loss. Covers the whole filtered set, not this page. Before tax.';

export const RETAIL_EXCLUDED_EXPLANATION =
  'Items holding stock in this scope that have no selling price, so they are ' +
  'absent from the retail and margin figures. An item held in two locations is ' +
  'counted once. Give it a price and it joins them.';

// The button that turns the excluded count into somewhere to go. Same principle
// as the negative-stock and low-stock counts: a figure that is a way in rather
// than a dead end.
export const UNPRICED_SELLABLE_FILTER_LABEL = 'Sold, but no price set';

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

// ---------------------------------------------------------------------------
// THE ⓘ PANELS (rule 25)
// ---------------------------------------------------------------------------
// Each is the explanation ONE screen used to open with, moved behind a single
// icon and written out in full in docs/USER-GUIDE.md, which each panel links to.
// The screens keep one line of purpose apiece.
//
// Assembled from the constants in this file wherever the sentence already
// existed, so moving the words did not fork them.

export const INVENTORY_ABOUT_TITLE = 'About this page';

export const INVENTORY_ABOUT: string[] = [
  'Every quantity and every cost on this page is added up from the movements ' +
    'recorded against an item — opening balances, adjustments, counts. Nothing ' +
    'is stored as a running total, so nothing can quietly drift out of step ' +
    'with the movements behind it.',
  'Stock is physical, so it belongs to a place. Each location holds its own ' +
    'quantity at its own cost; “All locations” adds those together for the ' +
    'whole hotel, and the Locations column shows the breakdown so a roll-up is ' +
    'never mistaken for one pile.',
  MOVING_AVERAGE_EXPLANATION,
  'Load opening stock is a day-one job, done once per location, AFTER the ' +
    'items exist: it loads QUANTITIES for items already in your catalogue. To ' +
    'create the items themselves, use Add product.',
];

export const ADJUSTMENTS_ABOUT_TITLE = 'About adjustments';

export const ADJUSTMENTS_ABOUT: string[] = [
  ADJUSTMENT_REASON_EXPLANATION,
  'An adjustment says the count was wrong. A write-off says we lost it, and ' +
    'why — spoilage, breakage, expiry, a staff meal. They are recorded as ' +
    'different things on purpose: blur them and the variance report stops ' +
    'meaning anything.',
  'The list below covers every location by default, not the one selected at ' +
    'the top of the page: somebody scanning corrections wants the hotel’s whole ' +
    'picture, and narrowing to one store is one click away.',
];

export const IMPORT_HISTORY_ABOUT_TITLE = 'About opening stock';

export const IMPORT_HISTORY_ABOUT: string[] = [
  IMPORT_HISTORY_NOTE,
  'An opening balance is a one-time event per item per location — the line the ' +
    'ledger starts from. After it, stock only ever moves by a recorded ' +
    'movement: a receipt, an issue, an adjustment, a count or a write-off.',
];

export const NEGATIVE_STOCK_ABOUT_TITLE = 'About negative stock';

export const NEGATIVE_STOCK_ABOUT: string[] = [
  NEGATIVE_STOCK_EXPLANATION,
  'This screen shows negatives the Products tab cannot: the ones sitting ' +
    'behind an item or a location that has been switched off or removed. Those ' +
    'are also the ones that cannot be corrected until something is switched ' +
    'back on, which is why they are worth a screen of their own.',
];

export const PRODUCTS_ABOUT_TITLE = 'About the product list';

export const PRODUCTS_ABOUT: string[] = [
  'This is your catalogue with its stock beside it, so an item with nothing on ' +
    'hand is still a row — that is what makes this the screen you add stock ' +
    'FROM, rather than one that only shows what you already have.',
  MOVING_AVERAGE_EXPLANATION,
  'The figures above the table cover the whole filtered set, across every ' +
    'page — never just the rows in front of you. Export writes the same set.',
  // 1.1e §2. The distinction the two money tiles rest on, in one paragraph, in
  // the place somebody can choose to read it rather than on the card itself.
  'Value at cost is what you paid for the stock; retail value is what it would ' +
    'bring in at your own prices, before tax. Margin compares only the items ' +
    'that have a price — your ingredients have none, so including them would ' +
    'count the whole store as a loss.',
  // 1.1e §1. Where the price lives and what a blank one means, because "blank" is
  // a real setting here and every screen that reads it treats it as one.
  'A selling price belongs to the item, and blank means the item is not sold — ' +
    'which is not the same as a price of zero. An outlet can charge something ' +
    'different, and when it does, that price wins at the till.',
  NEGATIVE_FILTER_CROSS_REFERENCE,
];
