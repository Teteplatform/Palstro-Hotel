import { buildWorkbookXlsx, numberCell, type SheetCell } from '../export/simpleSheet';
import { ITEM_TYPES, itemTypeLabel, unitDimensionLabel } from '../inventoryLabels';
import type {
  InventoryCategory,
  InventoryItem,
  UnitOfMeasure,
} from '../../types/inventory';

// ===========================================================================
// THE OPENING-STOCK SHEET — ONE download that does both jobs.
// ===========================================================================
//
// A hotel starting on this system has two facts to give us, and they used to be
// two screens, two templates and two uploads: "here is what we stock" and "here
// is what is on the shelf right now". Nobody does the second one. The catalogue
// arrives, the quantities never do, and the system spends its first month
// believing the store is empty.
//
// So this is ONE sheet with an OPENING QUANTITY column. A row for something the
// catalogue already has records its quantity; a row for something new creates
// the item AND records its quantity. Zero if zero, blank if you would rather not
// say — a blank is not a claim about an empty shelf.
//
// ---------------------------------------------------------------------------
// TWO TABS: DATA, then REFERENCE
// ---------------------------------------------------------------------------
// The REFERENCE tab lists the tenant's actual units, categories and the three
// item types — the exact strings that will validate — so filling the sheet in is
// choosing from a list rather than guessing at spellings. The data headers point
// at it ("(see Reference)") instead of explaining themselves in a paragraph.
//
// TAB ORDER IS LOAD-BEARING. lib/import/readSheet resolves the FIRST sheet in
// workbook order and imports that grid, so the data tab is first and the
// reference tab second. Reversing them would import the reference list.
//
// A CSV HAS NO SECOND TAB, so the reference goes ABOVE the header as quoted
// single-field lines. That is safe by construction rather than by luck:
// findHeader (openingBalances.ts) scans the first 20 rows for the row naming an
// item column and an opening-quantity column, so leading commentary is stepped
// over. The preamble below lands the header on row 9 of 20 — if you add lines
// here, COUNT THEM: past row 20 the whole file reads as "no header row".
//
// ---------------------------------------------------------------------------
// WHY CSV LEADS AND .xlsx IS OFFERED BESIDE IT
// ---------------------------------------------------------------------------
// Verified on this customer's own machine: a managed Windows laptop can be set
// to open every UNLABELLED .xlsx read-only, whatever wrote it (Microsoft's
// sensitivity labelling), and a file you cannot type into is a sheet that does
// not work. A browser cannot apply a label. CSV is untouched by the policy,
// opens and edits normally in Excel, and reads back through the same parser — so
// it leads, and the .xlsx (column widths, frozen header, a real Reference tab)
// is the better sheet when Excel behaves.

// THE COLUMN CONTRACT. These labels are what the validator's header matching is
// built around — it accepts common variations and ignores a trailing
// parenthetical, but these are the canonical spellings, so the writer and the
// reader stay in step even though they are separate modules.
export const OPENING_COLUMNS = [
  { label: 'Item name', width: 32 },
  { label: 'Code', width: 12 },
  { label: 'Type (see Reference)', width: 18 },
  { label: 'Base unit (see Reference)', width: 20 },
  { label: 'Category (see Reference)', width: 22 },
  { label: 'Barcode', width: 16 },
  { label: 'Pack size', width: 16 },
  { label: 'Purchase cost', width: 14 },
  { label: 'Min stock', width: 11 },
  { label: 'Max stock', width: 11 },
  { label: 'Reorder level', width: 13 },
  { label: 'Opening quantity', width: 17 },
  { label: 'Unit cost', width: 13 },
  { label: 'Note', width: 24 },
] as const;

const DATA_SHEET_NAME = 'Opening stock';
const REFERENCE_SHEET_NAME = 'Reference';

export interface OpeningSheetInput {
  // Every LIVE catalogue item, pre-filled one per row so the storekeeper walks
  // the store typing quantities rather than re-typing their whole catalogue.
  items: InventoryItem[];
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  // Where this sheet's stock is being loaded — named on the file so a sheet
  // filled in for the Main Store is not later uploaded against the Bar by
  // accident. Guidance only: the LOCATION IS CHOSEN ON THE SCREEN.
  locationName: string;
}

// ---------------------------------------------------------------------------
// The data grid
// ---------------------------------------------------------------------------

// One row per existing item, carrying what is on file — crucially ITS BASE UNIT,
// so nobody has to remember whether rice is tracked in kilograms or in bags —
// with the last three columns left for the person to fill in.
//
// THE DETAIL COLUMNS ON AN EXISTING ROW ARE READ-ONLY IN EFFECT: the import uses
// them only for rows it is CREATING. Editing an existing item's reorder level
// here changes nothing, and the guidance says so in one line rather than leaving
// somebody to discover it after re-typing three hundred of them.
function catalogueRows(input: OpeningSheetInput): SheetCell[][] {
  const categoryName = new Map(input.categories.map((c) => [c.id, c.name]));

  return input.items.map((item) => [
    { kind: 'text', value: item.name },
    text(item.code),
    { kind: 'text', value: itemTypeLabel(item.item_type) },
    { kind: 'text', value: item.base_unit },
    text(item.category_id ? (categoryName.get(item.category_id) ?? null) : null),
    text(item.barcode),
    text(item.pack_size),
    money(item.purchase_cost),
    quantity(item.min_stock_level),
    quantity(item.max_stock_level),
    quantity(item.reorder_level),
    null, // Opening quantity — the one they fill in
    null, // Unit cost — and this one
    null, // Note
  ]);
}

function text(value: string | null): SheetCell {
  return value ? { kind: 'text', value } : null;
}

// The catalogue's own figures, already parsed by the data layer (rule 24), so
// these place the number rather than re-reading it. A null stays an EMPTY cell:
// a 0 written into a purchase-cost cell is a claim that the item is free.
function money(value: number | null): SheetCell {
  return numberCell(value, 'money');
}

function quantity(value: number | null): SheetCell {
  return numberCell(value, 'quantity');
}

// ---------------------------------------------------------------------------
// The reference lists
// ---------------------------------------------------------------------------

function activeUnits(input: OpeningSheetInput): UnitOfMeasure[] {
  return input.units.filter((u) => u.is_active);
}

function activeCategories(input: OpeningSheetInput): InventoryCategory[] {
  return input.categories.filter((c) => c.is_active);
}

const REFERENCE_COLUMNS = [
  { label: 'Base unit', width: 16 },
  { label: 'Measures', width: 14 },
  { label: 'Category', width: 26 },
  { label: 'Type', width: 18 },
] as const;

// The three lists side by side, one tab, no prose. Each column is independent
// and simply runs out when it has no more rows — a hotel with 16 units and 8
// categories reads exactly as it should.
function referenceRows(input: OpeningSheetInput): SheetCell[][] {
  const units = activeUnits(input);
  const categories = activeCategories(input);
  const rows: SheetCell[][] = [];
  const height = Math.max(units.length, categories.length, ITEM_TYPES.length);

  for (let i = 0; i < height; i += 1) {
    rows.push([
      units[i] ? { kind: 'text', value: units[i].unit_code } : null,
      units[i]
        ? { kind: 'text', value: unitDimensionLabel(units[i].dimension) }
        : null,
      categories[i] ? { kind: 'text', value: categories[i].name } : null,
      ITEM_TYPES[i] ? { kind: 'text', value: itemTypeLabel(ITEM_TYPES[i]) } : null,
    ]);
  }
  return rows;
}

// The guidance, written ONCE and rendered into both formats so the CSV can never
// drift from the .xlsx. Seven lines, deliberately — this sheet's instructions
// belong on the sheet, not on the screen.
function guidanceLines(input: OpeningSheetInput): string[] {
  return [
    `OPENING STOCK — ${input.locationName}. Type an Opening quantity and Unit cost beside what you actually hold. Blank is skipped; 0 records no stock.`,
    'A row whose Item name is not in your catalogue CREATES that item. Fill in its Type, Base unit and Category from the Reference list.',
    'On a row you already have, only Opening quantity, Unit cost and Note are read — edit the item itself to change its details.',
    'Use Reference values exactly. Anything else is flagged when you upload and you choose whether to create it or map it — nothing is created behind your back.',
    'QUANTITY IS IN THAT ROW’S BASE UNIT. UNIT COST is what ONE base unit cost you, not the whole quantity.',
    'Use a full stop for decimals (12.5), never a comma.',
    'Re-uploading the same file is safe: an item can hold ONE opening balance per location, and rows already loaded are recognised and left alone.',
  ];
}

// ---------------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------------

export function buildOpeningSheetXlsx(
  input: OpeningSheetInput,
  currency: string,
  issueDate: string,
): Uint8Array {
  const columns = OPENING_COLUMNS.map((c) => ({ label: c.label, width: c.width }));

  const reference: SheetCell[][] = [
    ...referenceRows(input),
    [],
    ...guidanceLines(input).map((line): SheetCell[] => [
      { kind: 'text', value: line },
    ]),
  ];

  return buildWorkbookXlsx({
    sheets: [
      { name: DATA_SHEET_NAME, columns, rows: catalogueRows(input) },
      {
        name: REFERENCE_SHEET_NAME,
        columns: REFERENCE_COLUMNS.map((c) => ({
          label: c.label,
          width: c.width,
        })),
        rows: reference,
        freezeHeader: false,
      },
    ],
    currency,
    issueDate,
  });
}

// ---------------------------------------------------------------------------
// .csv — the headline format
// ---------------------------------------------------------------------------

// The BOM is not decoration: without it Excel reads the file in the system
// codepage and an item called "Chef's sauce" comes back as mojibake. readSheet
// strips it again on the way in.
const BOM = '﻿';

export function buildOpeningSheetCsv(input: OpeningSheetInput): string {
  const lines: string[] = [];
  const units = activeUnits(input).map((u) => u.unit_code);
  const categories = activeCategories(input).map((c) => c.name);

  // The reference, as three lines — a CSV has no second tab, so the list has to
  // travel with the file or the "(see Reference)" headers point at nothing.
  lines.push(
    csvRow([
      `REFERENCE — BASE UNITS: ${units.join(', ') || 'none set up yet'}`,
    ]),
  );
  lines.push(
    csvRow([
      `REFERENCE — CATEGORIES: ${categories.join(', ') || 'none set up yet'}`,
    ]),
  );
  lines.push(
    csvRow([`REFERENCE — TYPES: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}`]),
  );
  for (const line of guidanceLines(input)) {
    lines.push(csvRow([line]));
  }
  lines.push('');

  lines.push(csvRow(OPENING_COLUMNS.map((c) => c.label)));

  const categoryName = new Map(input.categories.map((c) => [c.id, c.name]));
  for (const item of input.items) {
    lines.push(
      csvRow([
        item.name,
        item.code ?? '',
        itemTypeLabel(item.item_type),
        item.base_unit,
        item.category_id ? (categoryName.get(item.category_id) ?? '') : '',
        item.barcode ?? '',
        item.pack_size ?? '',
        csvNumber(item.purchase_cost),
        csvNumber(item.min_stock_level),
        csvNumber(item.max_stock_level),
        csvNumber(item.reorder_level),
        '', // Opening quantity
        '', // Unit cost
        '', // Note
      ]),
    );
  }

  // CRLF, because this file is written to be opened by Excel on Windows.
  return BOM + lines.join('\r\n') + '\r\n';
}

// RFC 4180, the same grammar readCsv parses — quote whenever the field holds a
// delimiter, a quote or a newline, and double any quote inside, so a name like
// `Coca-Cola, 50cl "classic"` survives the round trip intact.
function csvField(value: string): string {
  if (/[",\r\n;\t]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// A figure in the CSV fallback. An absent one is an EMPTY field, never a 0 —
// the same distinction the .xlsx makes with an empty cell.
function csvNumber(value: number | null): string {
  return value === null ? '' : String(value);
}

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}
