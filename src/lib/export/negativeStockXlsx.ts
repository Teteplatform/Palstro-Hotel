import { buildSheetXlsx, type SheetCell } from './simpleSheet';
import { parseNumeric } from '../format';
import { isUncorrectable } from '../stock';
import type { StockNegativePositionRow } from '../../types/stock';

// The negative-positions export (rule 20): every row matching the CURRENT
// FILTER, across all pages — never the twenty rows on screen. The caller fetches
// the filtered set through the same filter builder the list and the totals use,
// so all three describe the same set.
//
// WHAT IT IS FOR: this is the list someone takes away to investigate. Each line
// is a question — where did this stock go? — and the answer is usually found in
// a delivery note nobody entered or an issue posted to the wrong store. So the
// sheet carries the location, the item and the shortfall as real NUMBERS the
// recipient can sort and total, plus the date of the last movement, which is
// where the trail starts.
//
// The "Can be corrected" column is the one that decides what to do first: a
// position behind a switched-off or removed parent has no write path at all
// until it is switched back on, so it needs a different action from the rest.

const COLUMNS = [
  { label: 'Item', width: 34 },
  { label: 'Code', width: 14 },
  { label: 'Location', width: 22 },
  { label: 'Category', width: 20 },
  { label: 'Base unit', width: 12 },
  { label: 'Quantity on hand', width: 18 },
  { label: 'Average cost', width: 16 },
  { label: 'Value of shortfall', width: 18 },
  { label: 'Last movement', width: 15 },
  { label: 'Can be corrected', width: 34 },
] as const;

// The sheet name is a GENERIC label, not the property's. Rule 17 forbids a
// tenant string in code, and threading the hotel's name down here to title a tab
// nobody reads would buy nothing — the export is already scoped to one property
// by the query that produced it.
export function buildNegativeStockXlsx(
  rows: StockNegativePositionRow[],
  currency: string,
  issueDate: string,
): Uint8Array {
  const body: SheetCell[][] = rows.map((row) => [
    { kind: 'text', value: row.item_name },
    row.item_code ? { kind: 'text', value: row.item_code } : null,
    { kind: 'text', value: row.location_name },
    row.category_name ? { kind: 'text', value: row.category_name } : null,
    { kind: 'text', value: row.base_unit },
    numberCell(row.quantity_on_hand, 'quantity'),
    numberCell(row.moving_average_cost, 'money'),
    numberCell(row.stock_value, 'money'),
    row.last_movement_date
      ? { kind: 'text', value: row.last_movement_date }
      : null,
    // Words rather than TRUE/FALSE, and the words name WHAT is in the way —
    // a column of FALSE would tell the reader there is a problem and not which.
    { kind: 'text', value: correctableCell(row) },
  ]);

  return buildSheetXlsx({
    sheetName: 'Negative stock',
    columns: COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows: body,
    currency,
    issueDate,
  });
}

// ONE definition of "correctable", shared with the screen via isUncorrectable —
// so the sheet and the badge can never disagree about a row.
function correctableCell(row: StockNegativePositionRow): string {
  if (!isUncorrectable(row)) return 'Yes';

  const blockers: string[] = [];
  if (row.location_deleted_at !== null) blockers.push('location removed');
  else if (!row.location_is_active) blockers.push('location switched off');
  if (row.item_deleted_at !== null) blockers.push('item removed');
  else if (!row.item_is_active) blockers.push('item switched off');

  return `No — ${blockers.join(', ')}`;
}

// §6: numeric columns arrive as STRINGS. Parsed explicitly — an unparseable or
// absent value becomes an EMPTY cell rather than a zero, because a zero here is
// a claim and a blank is the truth.
function numberCell(
  value: string | null,
  format: 'money' | 'quantity',
): SheetCell {
  const n = parseNumeric(value);
  if (n === null) return null;
  return { kind: 'number', value: n, format };
}
