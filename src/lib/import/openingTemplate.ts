import { buildWorkbookXlsx, type SheetCell } from '../export/simpleSheet';
import type { InventoryItem } from '../../types/inventory';

// The opening-balance spreadsheet TEMPLATE — the file a storekeeper downloads,
// fills in and uploads back. Offered in TWO formats, for a reason that is not
// cosmetic (see WHY CSV IS OFFERED below).
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
//
// ---------------------------------------------------------------------------
// WHY CSV IS OFFERED ALONGSIDE .xlsx
// ---------------------------------------------------------------------------
// A managed Windows laptop — which is what a hotel's office machine usually is —
// can be configured to open every UNLABELLED .xlsx read-only, whatever wrote it.
// Microsoft's sensitivity labelling does this, and it is indifferent to whether
// the workbook is well formed: a file Excel opens perfectly and refuses to let
// you type into is, to the storekeeper, a template that does not work.
//
// We cannot label a file from a browser, and we are not going to pretend a
// hotel's IT policy is our bug. What we CAN do is offer the same template as a
// .csv, which no labelling policy touches, which Excel opens and edits normally,
// and which this importer reads with the same parser and the same result. The
// .xlsx stays the default because it carries the column widths, the frozen
// header, the number formats and the instructions tab; the .csv is the way out
// when the .xlsx opens read-only.

export const TEMPLATE_COLUMNS = [
  { label: 'Item', width: 34 },
  { label: 'Code', width: 14 },
  { label: 'Base unit', width: 12 },
  { label: 'Location', width: 20 },
  { label: 'Quantity', width: 14 },
  { label: 'Unit cost', width: 16 },
  { label: 'Note', width: 30 },
] as const;

const DATA_SHEET_NAME = 'Opening balances';
const GUIDE_SHEET_NAME = 'How to fill this in';

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
function catalogueRows(
  items: InventoryItem[],
  locationName: string,
): SheetCell[][] {
  return items.map((item) => [
    { kind: 'text', value: item.name },
    item.code ? { kind: 'text', value: item.code } : null,
    { kind: 'text', value: item.base_unit },
    { kind: 'text', value: locationName },
    null, // Quantity — the one the user fills in
    null, // Unit cost — and this one
    null, // Note
  ]);
}

// The guidance, written once and rendered into both formats so the .csv can
// never drift from the .xlsx. Each line stands alone — they are read as a list,
// not as a paragraph.
function guidanceLines(locationName: string): string[] {
  return [
    'Type a quantity and a unit cost beside the things you actually have. Leave every other row blank — a blank row is SKIPPED, not treated as zero.',
    'QUANTITY IS IN THE ITEM’S OWN BASE UNIT — the unit printed in the “Base unit” column of that row. That column is there to read, not to change: the import always uses the unit held in your catalogue.',
    'UNIT COST is what ONE base unit cost you, not what the whole quantity cost.',
    'Use a full stop for decimals (12.5), never a comma. A comma is read as a thousands separator.',
    `Location is already filled in as “${locationName}”. Change a row’s location only if that stock sits somewhere else — the name must match one of your stock locations exactly.`,
    'Do not rename or reorder the columns. You may delete a column you do not use, except Item, Quantity and Unit cost.',
    'Add a row for an item that is not listed only after that item exists in your catalogue — the import matches on name or code and rejects anything it cannot find.',
    'An item can hold ONE opening balance per location. Re-uploading the same file is safe: rows already loaded are recognised and left alone.',
  ];
}

// An example, shown in the real columns so there is nothing to interpret. It
// lives on the GUIDE tab, never on the data tab, so it can never be imported by
// accident.
function exampleRow(locationName: string): SheetCell[] {
  return [
    { kind: 'text', value: 'EXAMPLE — Rice (long grain)' },
    { kind: 'text', value: 'FD-001' },
    { kind: 'text', value: 'kg' },
    { kind: 'text', value: locationName },
    { kind: 'number', value: 200, format: 'quantity' },
    { kind: 'number', value: 1250, format: 'money' },
    { kind: 'text', value: 'counted at opening' },
  ];
}

const EXAMPLE_READING =
  'Reading that row: 200 KILOGRAMS of rice are on the shelf, and one kilogram ' +
  'cost 1,250. Not 200 bags, and not 1,250 for the lot.';

// ---------------------------------------------------------------------------
// .xlsx — the default
// ---------------------------------------------------------------------------

// TAB ORDER IS LOAD-BEARING. lib/import/readSheet resolves the FIRST sheet in
// workbook order and imports that grid, so the data tab is first and the guide
// tab second. Reversing them would import the guidance.
export function buildOpeningTemplateXlsx(
  items: InventoryItem[],
  locationName: string,
  currency: string,
  issueDate: string,
): Uint8Array {
  const columns = TEMPLATE_COLUMNS.map((c) => ({
    label: c.label,
    width: c.width,
  }));

  const guide: SheetCell[][] = [
    exampleRow(locationName),
    [{ kind: 'text', value: EXAMPLE_READING }],
    [],
    ...guidanceLines(locationName).map((line): SheetCell[] => [
      { kind: 'text', value: line },
    ]),
  ];

  return buildWorkbookXlsx({
    sheets: [
      {
        name: DATA_SHEET_NAME,
        columns,
        rows: catalogueRows(items, locationName),
      },
      {
        name: GUIDE_SHEET_NAME,
        // The same headings as the data tab, so the example sits under the
        // column it belongs to and needs no explaining.
        columns,
        rows: guide,
        freezeHeader: false,
      },
    ],
    currency,
    issueDate,
  });
}

// ---------------------------------------------------------------------------
// .csv — the way out when a managed laptop opens .xlsx read-only
// ---------------------------------------------------------------------------

// A .csv has no second tab, so the guidance goes ABOVE the header as quoted
// single-field lines. That is safe by construction rather than by luck:
// findHeader (openingBalances.ts) scans the first 20 rows for the row that names
// an Item column and a Quantity column, so leading commentary is stepped over
// and the header is found wherever it lands. The preamble below lands the header
// on row 13 of 20 — if you add lines here, COUNT THEM: past row 20 the whole
// file reads as "no header row" and nothing can be imported.
//
// The BOM is not decoration: without it Excel reads the file in the system
// codepage, and an item called "Chef’s sauce" or a ₦ in a note comes back as
// mojibake. readSheet strips it again on the way in.
const BOM = '﻿';

export function buildOpeningTemplateCsv(
  items: InventoryItem[],
  locationName: string,
): string {
  const lines: string[] = [];

  lines.push(
    csvRow([
      `OPENING STOCK — ${locationName}. Keep these notes or delete them; the import steps over them either way.`,
    ]),
  );
  for (const line of guidanceLines(locationName)) {
    lines.push(csvRow([line]));
  }
  lines.push(csvRow(['Example of a filled row (the next line), then the real header, then your items:']));
  lines.push(
    csvRow([
      'EXAMPLE — Rice (long grain)',
      'FD-001',
      'kg',
      locationName,
      '200',
      '1250.00',
      'counted at opening',
    ]),
  );
  lines.push(csvRow([EXAMPLE_READING]));
  lines.push('');

  lines.push(csvRow(TEMPLATE_COLUMNS.map((c) => c.label)));
  for (const item of items) {
    lines.push(
      csvRow([
        item.name,
        item.code ?? '',
        item.base_unit,
        locationName,
        '', // Quantity
        '', // Unit cost
        '', // Note
      ]),
    );
  }

  // CRLF, because this file is written to be opened by Excel on Windows.
  return BOM + lines.join('\r\n') + '\r\n';
}

// RFC 4180. Quote whenever the field holds a delimiter, a quote or a newline,
// and double any quote inside — the same grammar readCsv parses, so a name like
// `Coca-Cola, 50cl "classic"` survives the round trip intact.
function csvField(value: string): string {
  if (/[",\r\n;\t]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}
