import { buildSheetXlsx, type SheetCell } from './simpleSheet';
import { parseNumeric } from '../format';
import { itemTypeLabel } from '../inventoryLabels';
import type { ProductRow } from '../inventoryProducts';

// THE INVENTORY EXPORT (rule 20): every row matching the CURRENT FILTER, across
// all pages — never the rows the user happens to be looking at. The caller
// fetches the filtered set through the same filter builders the list and the
// totals use, so all three describe the same stock.
//
// WHAT IT IS FOR: the count sheet and the owner's spreadsheet. Quantities, costs
// and values are real NUMBERS in their cells, not formatted text, because the
// recipient has to be able to add a column up and subtract one from another.
// The value column carries the property's own currency as a cell FORMAT (rule 17
// — the code arrives from the database, never a literal).
//
// The Locations column is the same "Main Store: 62 · Kitchen: 1" breakdown the
// screen shows, flattened to text: a spreadsheet cannot hold a nested list, and
// one row per location would stop the item column being a key.

const COLUMNS = [
  { label: 'Item', width: 34 },
  { label: 'Code', width: 14 },
  { label: 'Category', width: 20 },
  { label: 'Type', width: 14 },
  { label: 'Unit', width: 10 },
  { label: 'Average cost', width: 16 },
  { label: 'On hand', width: 14 },
  { label: 'Stock value', width: 16 },
  { label: 'Locations', width: 40 },
  { label: 'Reorder level', width: 15 },
  { label: 'Low stock', width: 11 },
  { label: 'In use', width: 10 },
] as const;

export function buildProductsXlsx(
  rows: ProductRow[],
  scopeName: string,
  currency: string,
  issueDate: string,
): Uint8Array {
  const body: SheetCell[][] = rows.map((row) => [
    { kind: 'text', value: row.name },
    row.code ? { kind: 'text', value: row.code } : null,
    row.categoryName ? { kind: 'text', value: row.categoryName } : null,
    { kind: 'text', value: itemTypeLabel(row.itemType) },
    { kind: 'text', value: row.baseUnit },
    numberCell(row.averageCost, 'money'),
    numberCell(row.quantity, 'quantity'),
    numberCell(row.value, 'money'),
    row.locations.length > 0
      ? {
          kind: 'text',
          value: row.locations
            .map((l) => `${l.locationName}: ${l.quantity}`)
            .join(', '),
        }
      : null,
    numberCell(row.reorderLevel, 'quantity'),
    // Words rather than TRUE/FALSE: a column of TRUE and blank reads as a bug.
    row.isBelowReorder ? { kind: 'text', value: 'Low' } : null,
    row.isActive ? null : { kind: 'text', value: 'Not in use' },
  ]);

  return buildSheetXlsx({
    sheetName: scopeName,
    columns: COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows: body,
    currency,
    issueDate,
  });
}

// §6: numeric columns arrive as STRINGS. Parsed explicitly — an unparseable or
// absent value becomes an EMPTY cell rather than a zero, because a zero in a
// count sheet is a claim ("there is none") and a blank is the truth ("we have no
// figure"). The same distinction the MISSING_VALUE dash makes on screen.
function numberCell(
  value: string | null,
  format: 'money' | 'quantity',
): SheetCell {
  const n = parseNumeric(value);
  if (n === null) return null;
  return { kind: 'number', value: n, format };
}
