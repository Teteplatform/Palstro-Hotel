import { buildSheetXlsx, type SheetCell } from './simpleSheet';
import { parseNumeric } from '../format';
import type { StockOnHandRow } from '../../types/stock';

// The stock-on-hand export (rule 20): every row matching the CURRENT FILTER,
// across all pages — never the twenty rows the user happens to be looking at.
// The caller fetches the filtered set with the same filter builder the list and
// the total use, so all three describe the same stock.
//
// WHAT IT IS FOR, in practice: this is the count sheet. A storekeeper prints or
// opens it, walks the store, and writes what is actually there beside what the
// system says — which is the manual half of the variance the stock-count tranche
// will later automate. That is why the quantity, the cost and the value are real
// NUMBERS in the cells, not formatted text: the recipient has to be able to add
// a column up and subtract one from another.
//
// The value column carries the property's own currency as a cell FORMAT (rule
// 17 — the code arrives from the database, never a literal), so it displays what
// the screen displays while staying arithmetic.

const COLUMNS = [
  { label: 'Item', width: 34 },
  { label: 'Code', width: 14 },
  { label: 'Category', width: 20 },
  { label: 'Base unit', width: 12 },
  { label: 'Quantity on hand', width: 18 },
  { label: 'Moving average cost', width: 20 },
  { label: 'Stock value', width: 16 },
  { label: 'Reorder level', width: 15 },
  { label: 'Low stock', width: 11 },
  { label: 'Last movement', width: 15 },
] as const;

export function buildStockXlsx(
  rows: StockOnHandRow[],
  locationName: string,
  currency: string,
  issueDate: string,
): Uint8Array {
  const body: SheetCell[][] = rows.map((row) => [
    { kind: 'text', value: row.item_name },
    row.item_code ? { kind: 'text', value: row.item_code } : null,
    row.category_name ? { kind: 'text', value: row.category_name } : null,
    { kind: 'text', value: row.base_unit },
    numberCell(row.quantity_on_hand, 'quantity'),
    numberCell(row.moving_average_cost, 'money'),
    numberCell(row.stock_value, 'money'),
    numberCell(row.reorder_level, 'quantity'),
    // Words rather than TRUE/FALSE: a column of TRUE and blank reads as a bug.
    row.is_below_reorder ? { kind: 'text', value: 'Low' } : null,
    row.last_movement_date
      ? { kind: 'text', value: row.last_movement_date }
      : null,
  ]);

  return buildSheetXlsx({
    sheetName: locationName,
    columns: COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows: body,
    currency,
    issueDate,
  });
}

// §6: numeric columns arrive as STRINGS. Parsed explicitly — an unparseable or
// absent value becomes an EMPTY cell rather than a zero, because a zero in a
// count sheet is a claim ("there is none") and a blank is the truth ("we have no
// figure"). Same distinction the MISSING_VALUE dash makes on screen.
function numberCell(
  value: string | null,
  format: 'money' | 'quantity',
): SheetCell {
  const n = parseNumeric(value);
  if (n === null) return null;
  return { kind: 'number', value: n, format };
}
