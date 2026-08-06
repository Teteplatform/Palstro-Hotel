import { buildSheetXlsx, type SheetCell } from '../export/simpleSheet';
import type { InventoryItem } from '../../types/inventory';

// The opening-balance spreadsheet TEMPLATE — the file a storekeeper downloads,
// fills in and uploads back.
//
// KEPT IN ITS OWN MODULE, apart from the validator that reads the file back,
// for a bundling reason with a real cost behind it: the validator runs on every
// upload and has to be in the import screen's own chunk, while the WRITER pulls
// in the OOXML machinery and fflate and is only needed by the person who
// actually clicks Download. One module for both would drag the writer into the
// main bundle for everyone — and it is the customer, on a Nigerian mobile
// connection, who pays for that (the same reasoning as lib/export/ooxml.ts).
//
// The COLUMN NAMES here are the contract the validator's header matching is
// built around (it accepts common variations, but these are the canonical
// spellings), so the two files stay in step even though they are apart.

export const TEMPLATE_COLUMNS = [
  { label: 'Item', width: 34 },
  { label: 'Code', width: 14 },
  { label: 'Base unit', width: 12 },
  { label: 'Location', width: 20 },
  { label: 'Quantity', width: 14 },
  { label: 'Unit cost', width: 16 },
  { label: 'Note', width: 30 },
] as const;

// The template is PRE-FILLED with the whole catalogue — one row per active item,
// carrying its name, its code and, crucially, ITS BASE UNIT. The storekeeper
// walks the store and types a quantity beside the things they actually have,
// which is the difference between a template and a blank page: nobody has to
// remember whether rice is tracked in kilograms or in bags, because the row says
// so. Rows left blank are skipped, not treated as zero.
//
// Base unit is GUIDANCE — the import reads the item's real base unit from the
// catalogue and ignores this column, so editing it cannot silently rescale
// anything.
export function buildOpeningTemplate(
  items: InventoryItem[],
  locationName: string,
  currency: string,
  issueDate: string,
): Uint8Array {
  const rows: SheetCell[][] = items.map((item) => [
    { kind: 'text', value: item.name },
    item.code ? { kind: 'text', value: item.code } : null,
    { kind: 'text', value: item.base_unit },
    { kind: 'text', value: locationName },
    null, // Quantity — the one the user fills in
    null, // Unit cost — and this one
    null, // Note
  ]);

  return buildSheetXlsx({
    sheetName: 'Opening balances',
    columns: TEMPLATE_COLUMNS.map((c) => ({ label: c.label, width: c.width })),
    rows,
    currency,
    issueDate,
  });
}
