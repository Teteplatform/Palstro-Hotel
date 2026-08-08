import { buildWorkbookXlsx, type SheetCell } from '../export/simpleSheet';
import { ITEM_TYPES, itemTypeLabel } from '../inventoryLabels';
import { SAMPLE_PREFIX } from './templateSamples';
import type { InventoryCategory, UnitOfMeasure } from '../../types/inventory';

// ===========================================================================
// THE PRODUCT TEMPLATE — for CREATING ITEMS, not for loading stock.
// ===========================================================================
//
// The distinction this file exists to enforce, because conflating the two is
// what sent people to the wrong screen in the first place:
//
//   THIS template defines WHAT A THING IS — "Rice exists, it is an ingredient,
//   it is tracked in kilograms, it files under Grains". One row, one
//   inventory_items row, no quantity anywhere on it.
//
//   The OPENING-STOCK template (openingTemplate.ts) records HOW MUCH OF IT IS
//   ON A SHELF — "there are 200 kg of rice in the Main Store". It is filled in
//   AFTER the items exist, because every one of its rows has to match an item
//   by name.
//
// They share the writer in lib/export/simpleSheet and nothing else. Neither has
// a column the other has.
//
// ---------------------------------------------------------------------------
// WHY CSV IS THE HEADLINE FORMAT AND .xlsx THE ALTERNATIVE
// ---------------------------------------------------------------------------
// Same reason as the opening-stock template, verified on this customer's own
// machine: a managed Windows laptop can be set to open every UNLABELLED .xlsx
// read-only, whatever wrote it (Microsoft's sensitivity labelling), and a file
// you cannot type into is a template that does not work. A browser cannot apply
// a label. CSV is untouched by the policy, opens and edits normally in Excel,
// and reads back through the same parser — so it leads, and the .xlsx (which
// carries the column widths, the frozen header and the guidance tab) is offered
// beside it.
//
// ---------------------------------------------------------------------------
// SAMPLE ROWS, AND WHY THEY CANNOT BE IMPORTED BY ACCIDENT
// ---------------------------------------------------------------------------
// The template ships with worked example rows IN THE GRID, where somebody
// filling it in can see the shape of a real row rather than reading a
// description of one. That creates an obvious hazard — a user who adds their
// items below the examples and uploads the lot would create three products
// nobody asked for — so every sample name carries the SAMPLE_PREFIX below, and
// the validator skips any row whose name starts with it (see isSampleName).
//
// The marker is a visible prefix rather than a hidden column or a magic row
// number, because all three have to survive a user who sorts the sheet, deletes
// a column, or pastes their own rows in the middle. A prefix travels with the
// row it belongs to and is readable by the person holding the file.

export const PRODUCT_TEMPLATE_COLUMNS = [
  { label: 'Name', width: 32 },
  { label: 'Code', width: 12 },
  { label: 'Type', width: 16 },
  { label: 'Base unit', width: 14 },
  { label: 'Category', width: 20 },
  // The standard field set (037). All optional — a hotel that fills in nothing
  // past Category gets exactly the catalogue it got before. Supplier and
  // selling price are deliberately absent: see the item form's header.
  { label: 'Barcode', width: 16 },
  { label: 'Pack size', width: 16 },
  { label: 'Purchase cost', width: 14 },
  { label: 'Min stock', width: 11 },
  { label: 'Max stock', width: 11 },
  { label: 'Reorder level', width: 13 },
] as const;

const DATA_SHEET_NAME = 'Products';
const GUIDE_SHEET_NAME = 'How to fill this in';

// The marker itself lives in ./templateSamples, WITHOUT this file's OOXML
// dependencies, so the validator can recognise a sample row without dragging
// the spreadsheet writer into the main bundle. See that file for the full
// reason — it is a real bundling constraint, not tidiness.

// The examples, chosen to cover the three item types rather than to look
// plausible — the type column is the one an owner gets wrong in a way that only
// surfaces months later (see inventoryLabels), so each sample row demonstrates
// a different answer to it.
interface SampleRow {
  name: string;
  code: string;
  type: string;
  unit: string;
  category: string;
  barcode: string;
  packSize: string;
  purchaseCost: string;
  minStock: string;
  maxStock: string;
  reorder: string;
}

function sampleRows(units: UnitOfMeasure[], categories: InventoryCategory[]): SampleRow[] {
  // The samples name REAL units and REAL categories from this tenant wherever
  // possible. A sample citing a unit the tenant does not have would teach the
  // wrong thing and then fail validation on its own example.
  const unit = (preferred: string, fallbackIndex: number) =>
    units.find((u) => u.unit_code === preferred && u.is_active)?.unit_code ??
    units.filter((u) => u.is_active)[fallbackIndex]?.unit_code ??
    units[0]?.unit_code ??
    '';
  const category = (index: number) =>
    categories.filter((c) => c.is_active)[index]?.name ?? '';

  return [
    {
      name: `${SAMPLE_PREFIX}Rice (long grain)`,
      code: 'FD-001',
      type: itemTypeLabel('raw'),
      unit: unit('kg', 0),
      category: category(0),
      barcode: '',
      packSize: '25 kg bag',
      purchaseCost: '1250',
      minStock: '50',
      maxStock: '400',
      reorder: '50',
    },
    {
      name: `${SAMPLE_PREFIX}Coca-Cola 50cl`,
      code: 'BV-014',
      type: itemTypeLabel('both'),
      unit: unit('piece', 1),
      category: category(1),
      barcode: '5449000000996',
      packSize: 'carton of 24',
      purchaseCost: '450',
      minStock: '24',
      maxStock: '240',
      reorder: '24',
    },
    // The third sample is deliberately sparse: everything past Category is
    // optional, and a template whose every example is fully filled in teaches
    // that they are all required.
    {
      name: `${SAMPLE_PREFIX}Bar soap`,
      code: '',
      type: itemTypeLabel('raw'),
      unit: unit('piece', 1),
      category: category(2),
      barcode: '',
      packSize: '',
      purchaseCost: '',
      minStock: '',
      maxStock: '',
      reorder: '',
    },
  ];
}

// The guidance, written once and rendered into both formats so the CSV can
// never drift from the .xlsx.
function guidanceLines(
  units: UnitOfMeasure[],
  categories: InventoryCategory[],
): string[] {
  const activeUnits = units.filter((u) => u.is_active).map((u) => u.unit_code);
  const activeCategories = categories.filter((c) => c.is_active).map((c) => c.name);

  return [
    `The rows beginning “${SAMPLE_PREFIX.trim()}” are examples. They are IGNORED by the import, so you can type over them or delete them — either is fine.`,
    'One row per product. This sheet creates the ITEMS; it records no quantities. Loading what is on your shelves is a separate step, under “Load opening stock”.',
    'NAME is required and must be unique. An item whose name already exists is skipped rather than created, and the upload tells you which.',
    'CODE is optional, and must also be unique if you use one. Leave it blank if you do not use codes.',
    `TYPE is required and must be one of: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}. “${itemTypeLabel('both')}” is for a thing you sell on its own AND use in a recipe — a 50cl Coke sold at the bar and poured into a cocktail.`,
    activeUnits.length > 0
      ? `BASE UNIT is required and must be one of your units: ${activeUnits.join(', ')}. It is the smallest unit you actually measure in — everything is entered in it, so there are no “cartons of 12” to set up.`
      : 'BASE UNIT is required, and this catalogue has no units set up yet. Add them before importing.',
    activeCategories.length > 0
      ? `CATEGORY is optional and must match one of yours exactly: ${activeCategories.join(', ')}. Leave it blank for no category — the import will not invent one.`
      : 'CATEGORY is optional. This catalogue has no categories yet, so leave the column blank, or add categories on the Categories tab first.',
    'REORDER LEVEL is optional — the amount, in the base unit, below which you want warning. Leave it blank not to track it. Use a full stop for decimals.',
    'BARCODE, PACK SIZE, PURCHASE COST, MIN STOCK and MAX STOCK are all optional. Pack size is a description (“carton of 24”); stock is still counted in the base unit. Purchase cost is what ONE base unit normally costs to buy — your stock is still valued at what you actually paid.',
    'MIN and MAX STOCK are the ordering range for later; the low-stock warning uses Reorder level.',
    'Uploading the same file twice is safe: names that already exist are recognised and skipped, never created a second time.',
  ];
}

const SIMILARITY_NOTE =
  'The upload also warns about names that merely LOOK alike — “Rice” beside an ' +
  'existing “White Rice” — and asks you to confirm before creating them. Two ' +
  'rows for one thing cannot be merged later, because their movements are ' +
  'permanent.';

// ---------------------------------------------------------------------------
// .xlsx
// ---------------------------------------------------------------------------

// TAB ORDER IS LOAD-BEARING. lib/import/readSheet imports the FIRST sheet in
// workbook order, so the grid is first and the guidance second.
export function buildProductTemplateXlsx(
  units: UnitOfMeasure[],
  categories: InventoryCategory[],
  currency: string,
  issueDate: string,
): Uint8Array {
  const columns = PRODUCT_TEMPLATE_COLUMNS.map((c) => ({
    label: c.label,
    width: c.width,
  }));

  const data: SheetCell[][] = sampleRows(units, categories).map((s) => [
    { kind: 'text', value: s.name },
    s.code ? { kind: 'text', value: s.code } : null,
    { kind: 'text', value: s.type },
    s.unit ? { kind: 'text', value: s.unit } : null,
    s.category ? { kind: 'text', value: s.category } : null,
    // A barcode is a TEXT cell even though it is all digits: written as a
    // number, Excel renders 5449000000996 in scientific notation and strips a
    // leading zero, and the file that comes back no longer holds the barcode.
    s.barcode ? { kind: 'text', value: s.barcode } : null,
    s.packSize ? { kind: 'text', value: s.packSize } : null,
    s.purchaseCost
      ? { kind: 'number', value: Number(s.purchaseCost), format: 'money' }
      : null,
    s.minStock
      ? { kind: 'number', value: Number(s.minStock), format: 'quantity' }
      : null,
    s.maxStock
      ? { kind: 'number', value: Number(s.maxStock), format: 'quantity' }
      : null,
    s.reorder
      ? { kind: 'number', value: Number(s.reorder), format: 'quantity' }
      : null,
  ]);

  const guide: SheetCell[][] = [
    [{ kind: 'text', value: SIMILARITY_NOTE }],
    [],
    ...guidanceLines(units, categories).map((line): SheetCell[] => [
      { kind: 'text', value: line },
    ]),
  ];

  return buildWorkbookXlsx({
    sheets: [
      { name: DATA_SHEET_NAME, columns, rows: data },
      {
        name: GUIDE_SHEET_NAME,
        columns: [{ label: 'How to fill in the Products tab', width: 120 }],
        rows: guide,
        freezeHeader: false,
      },
    ],
    // No money column on this sheet at all — an item definition has no price and
    // no cost. The currency is still passed to the writer because the shared
    // style table declares the money format either way (rule 17: it arrives from
    // the database, never a literal).
    currency,
    issueDate,
  });
}

// ---------------------------------------------------------------------------
// .csv — the headline format
// ---------------------------------------------------------------------------

// Guidance goes ABOVE the header as quoted single-field lines, which is safe by
// construction rather than by luck: findProductHeader scans the first 20 rows
// for the row naming a Name column and a Base unit column, so leading
// commentary is stepped over. The preamble below lands the header on row 14 of
// 20 — if you add lines here, COUNT THEM.
//
// The BOM is not decoration: without it Excel reads the file in the system
// codepage and an item called "Chef’s sauce" comes back as mojibake. readSheet
// strips it again on the way in.
const BOM = '﻿';

export function buildProductTemplateCsv(
  units: UnitOfMeasure[],
  categories: InventoryCategory[],
): string {
  const lines: string[] = [];

  lines.push(
    csvRow([
      'NEW PRODUCTS — this sheet creates item definitions. It records no quantities. Keep these notes or delete them; the import steps over them either way.',
    ]),
  );
  for (const line of guidanceLines(units, categories)) {
    lines.push(csvRow([line]));
  }
  lines.push(csvRow([SIMILARITY_NOTE]));
  lines.push('');

  lines.push(csvRow(PRODUCT_TEMPLATE_COLUMNS.map((c) => c.label)));
  for (const s of sampleRows(units, categories)) {
    lines.push(
      csvRow([
        s.name,
        s.code,
        s.type,
        s.unit,
        s.category,
        s.barcode,
        s.packSize,
        s.purchaseCost,
        s.minStock,
        s.maxStock,
        s.reorder,
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

function csvRow(fields: string[]): string {
  return fields.map(csvField).join(',');
}
