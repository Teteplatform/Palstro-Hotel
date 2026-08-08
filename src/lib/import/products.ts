import { createInventoryItem } from '../inventory';
import { ITEM_TYPES, itemTypeLabel } from '../inventoryLabels';
import {
  checkName,
  cleanName,
  exactDuplicateMessage,
  codeClashMessage,
  similarNamesMessage,
  exactKey,
  type NameIndexEntry,
  type SimilarMatch,
} from '../inventoryDuplicates';
// From ./templateSamples, NOT from ./productTemplate: importing it from the
// template writer would be a static edge into the OOXML machinery and would
// pull the whole spreadsheet writer into the main bundle (see that file).
import { isSampleName } from './templateSamples';
import type { SheetData } from './readSheet';
import type {
  InventoryCategory,
  ItemType,
  UnitOfMeasure,
} from '../../types/inventory';

// ===========================================================================
// THE PRODUCT SPREADSHEET: VALIDATE, THEN COMMIT.
// ===========================================================================
//
// Bringing a whole catalogue in at once — the job a hotel does on its first
// afternoon, and the one where a mistake is made three hundred rows at a time.
// The shape is deliberately the same as the opening-balance import
// (openingBalances.ts), because the two screens sit beside each other and a
// person who has learned one should not have to learn the other:
//
//   NOTHING IS WRITTEN UNTIL EVERY ROW HAS BEEN CHECKED AND THE USER HAS SEEN
//   THE RESULT.
//
// What it creates is ITEM DEFINITIONS ONLY. There is no quantity column, no
// cost column and no location on this sheet; stock is loaded afterwards, by the
// opening-stock import, whose every row has to match an item created here.
//
// ---------------------------------------------------------------------------
// DUPLICATES — the whole reason this file is not four lines of insert
// ---------------------------------------------------------------------------
// Three verdicts, and only one of them is a refusal:
//
//   EXACT name (or code) already live  -> BLOCKED. Never created, never
//      attempted. lib/inventoryDuplicates decides this using the same
//      expression as 035's unique index, so the screen and the database agree.
//   SIMILAR name                       -> AMBER. Created, but only after the
//      user has seen the near-matches and explicitly confirmed. A judgement
//      that belongs to the storekeeper, not to a similarity score.
//   Anything else wrong (unknown unit, unknown category, bad type)
//                                      -> BLOCKED with the reason on the row.
//
// AND THE READ-SIDE CHECK IS NOT THE GUARD (rule 19 in its own shape). Two
// people importing overlapping files at the same moment both read a catalogue
// without the other's rows, so both previews show green. The unique index is
// what actually holds, and commitProducts treats a 23505 as a NORMAL outcome —
// "already exists, skipped" — rather than as an error. That is also what makes
// re-uploading the same file safe, which is the property rule 2's idempotency
// keys buy elsewhere: here the natural key IS the name, and the database
// already enforces it.

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

// Headers are matched by NAME, not by position, so a user may reorder or delete
// columns they do not need. Each field lists the spellings people actually type.
// `barcode` is its OWN field, deliberately not an alias of `code`: 037 made them
// two different columns owned by two different parties (the hotel's own short
// reference, and the manufacturer's scanned code), and folding one into the
// other would file an EAN as the storekeeper's bin-card code.
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['name', 'item', 'item name', 'product', 'product name', 'description'],
  code: ['code', 'item code', 'sku', 'product code'],
  type: ['type', 'item type', 'product type', 'kind'],
  baseUnit: ['base unit', 'unit', 'uom', 'unit of measure', 'measured in'],
  category: ['category', 'group', 'item category', 'product category'],
  barcode: ['barcode', 'bar code', 'ean', 'scan code'],
  packSize: ['pack size', 'pack', 'packing', 'packed as'],
  purchaseCost: ['purchase cost', 'buy cost', 'cost price', 'standard cost'],
  minStock: ['min stock', 'min stock level', 'minimum', 'min level', 'min'],
  maxStock: ['max stock', 'max stock level', 'maximum', 'max level', 'par level', 'max'],
  reorderLevel: ['reorder level', 'reorder', 'reorder point', 'warn below'],
};

type ColumnMap = Partial<Record<keyof typeof COLUMN_ALIASES, number>>;

// A TRAILING PARENTHETICAL IS STRIPPED, matching the opening-stock reader, so a
// heading that points at a reference list ("Base unit (see Reference)") still
// matches. One rule in both readers, so a sheet filled in from either template
// uploads to either screen.
function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find the header row and map each known field to its column index. The header
// is not assumed to be row 1: the template puts its notes above it, and people
// add a title row of their own.
function findProductHeader(
  rows: string[][],
): { index: number; map: ColumnMap } | null {
  const limit = Math.min(rows.length, 20); // a header past row 20 is not a header
  for (let i = 0; i < limit; i += 1) {
    const map: ColumnMap = {};
    rows[i].forEach((cell, col) => {
      const header = normaliseHeader(cell);
      if (!header) return;
      for (const [field, aliases] of Object.entries(COLUMN_ALIASES)) {
        if (map[field as keyof ColumnMap] === undefined && aliases.includes(header)) {
          map[field as keyof ColumnMap] = col;
        }
      }
    });
    // A row is THE header when it names a Name column and a Base unit column —
    // the two without which a row cannot become an item at all.
    if (map.name !== undefined && map.baseUnit !== undefined) {
      return { index: i, map };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Value parsing
// ---------------------------------------------------------------------------

// Types are accepted as either the DB value ('raw') or the label a person reads
// on screen ('Ingredient'), because the template prints the label and somebody
// reading the database docs will type the value. Both are unambiguous.
function parseType(raw: string): ItemType | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const direct = ITEM_TYPES.find((t) => t === value);
  if (direct) return direct;
  const byLabel = ITEM_TYPES.find(
    (t) => itemTypeLabel(t).toLowerCase() === value,
  );
  if (byLabel) return byLabel;
  // The two people actually type that are neither.
  if (value === 'ingredient') return 'raw';
  if (value === 'sold as is' || value === 'sold as-is' || value === 'finished good') {
    return 'finished';
  }
  return null;
}

// The same conservative reader as the opening-balance import, kept in step
// deliberately: a reorder level is a quantity, and quantities are read the same
// way everywhere. Anything that is not a digit, separator or minus is stripped;
// when BOTH separators appear the LAST one is the decimal point; a lone comma
// before exactly three digits is a thousands separator.
export function parseQuantityCell(raw: string): number | null {
  let s = raw.trim().replace(/[^\d.,-]/g, '');
  if (!s) return null;

  const negative = s.trimStart().startsWith('-');
  s = s.replace(/-/g, '');
  if (!s) return null;

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');

  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    const digitsAfter = s.length - lastComma - 1;
    const commaCount = (s.match(/,/g) ?? []).length;
    if (commaCount === 1 && digitsAfter !== 3) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  }

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

// 'new'       — green. Will be created.
// 'similar'   — amber. Will be created, but only after explicit confirmation.
// 'duplicate' — red. A live item already owns this name or code. Never created.
// 'error'     — red. The row cannot become an item; the message says why.
// 'sample'    — grey. One of the template's own example rows. Skipped silently.
export type ProductRowStatus = 'new' | 'similar' | 'duplicate' | 'error' | 'sample';

export interface ProductPreviewRow {
  // The spreadsheet's OWN row number, so "row 47" on screen is row 47 in Excel.
  rowNumber: number;
  status: ProductRowStatus;
  message: string;
  // Echoed back so the preview is readable without the file open beside it.
  rawName: string;
  rawCode: string;
  rawType: string;
  rawUnit: string;
  rawCategory: string;
  rawReorder: string;
  // Resolved values, present on a row that will be created.
  name?: string;
  code?: string | null;
  itemType?: ItemType;
  baseUnit?: string;
  categoryId?: string | null;
  categoryName?: string | null;
  reorderLevel?: number | null;
  // The standard field set (037). All optional, all null when not stated —
  // never '' and never 0, which the database and every report read differently.
  barcode?: string | null;
  packSize?: string | null;
  purchaseCost?: number | null;
  minStockLevel?: number | null;
  maxStockLevel?: number | null;
  // The near-matches behind an amber row, for the review list.
  similar?: SimilarMatch[];
  similarTotal?: number;
}

export interface ProductPreview {
  rows: ProductPreviewRow[];
  newCount: number;
  similarCount: number;
  duplicateCount: number;
  errorCount: number;
  sampleCount: number;
  sheetName: string;
  format: 'xlsx' | 'csv';
  // A fatal problem with the file as a whole. When set, nothing can be
  // imported and rows is empty.
  fatal?: string;
}

export interface ValidateProductsInput {
  sheet: SheetData;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  // Every live item in the tenant catalogue, from fetchNameIndex.
  nameIndex: NameIndexEntry[];
}

export function validateProductSheet(
  input: ValidateProductsInput,
): ProductPreview {
  const { sheet, units, categories, nameIndex } = input;

  const empty = {
    rows: [],
    newCount: 0,
    similarCount: 0,
    duplicateCount: 0,
    errorCount: 0,
    sampleCount: 0,
    sheetName: sheet.sheetName,
    format: sheet.format,
  };

  const header = findProductHeader(sheet.rows);
  if (!header) {
    return {
      ...empty,
      fatal:
        'This file has no header row naming a “Name” column and a “Base unit” column. Download the template and use its headings.',
    };
  }
  const { index: headerIndex, map } = header;
  if (map.type === undefined) {
    return {
      ...empty,
      fatal:
        'This file has no “Type” column. Every item has to say whether it is an ingredient, sold as-is, or both — it decides whether a sale takes it off the shelf, so it cannot be guessed.',
    };
  }

  // Lookups. Unit codes are stored lowercase (035 constrains them), so the
  // comparison is on the lowercased cell.
  const unitByCode = new Map(
    units.map((u) => [u.unit_code.trim().toLowerCase(), u]),
  );
  const categoryByName = new Map<string, InventoryCategory[]>();
  for (const c of categories) {
    const key = c.name.trim().toLowerCase();
    const existing = categoryByName.get(key);
    if (existing) existing.push(c);
    else categoryByName.set(key, [c]);
  }

  const activeUnitList = units
    .filter((u) => u.is_active)
    .map((u) => u.unit_code)
    .join(', ');

  // Names claimed EARLIER IN THIS FILE. Two rows for one name is a mistake in
  // the file, not two items — and left unreported the second would fail at the
  // database after the first had already been created.
  const seenNames = new Map<string, number>();
  const seenCodes = new Map<string, number>();

  // A GROWING view of the catalogue: rows accepted earlier in this file are
  // appended, so row 40 is checked against row 12's new item as well as against
  // what was already in the database. Without this, a file containing both
  // "Rice" and "White Rice" would report neither as similar to the other.
  const index: NameIndexEntry[] = [...nameIndex];

  const rows: ProductPreviewRow[] = [];
  let newCount = 0;
  let similarCount = 0;
  let duplicateCount = 0;
  let errorCount = 0;
  let sampleCount = 0;

  for (let i = headerIndex + 1; i < sheet.rows.length; i += 1) {
    const cells = sheet.rows[i];
    const rowNumber = i + 1; // 1-based, matching what Excel shows

    const rawName = cell(cells, map.name);
    const rawCode = cell(cells, map.code);
    const rawType = cell(cells, map.type);
    const rawUnit = cell(cells, map.baseUnit);
    const rawCategory = cell(cells, map.category);
    const rawReorder = cell(cells, map.reorderLevel);

    const base: ProductPreviewRow = {
      rowNumber,
      status: 'error',
      message: '',
      rawName,
      rawCode,
      rawType,
      rawUnit,
      rawCategory,
      rawReorder,
    };

    // A completely empty row is not an error — a spreadsheet is full of them.
    if (!rawName && !rawCode && !rawType && !rawUnit && !rawCategory && !rawReorder) {
      continue;
    }

    // The template's own example rows, recognised by their prefix and skipped
    // before anything else is judged about them. Counted and shown, so a user
    // who expected them to import can see exactly what happened.
    if (isSampleName(rawName)) {
      rows.push({
        ...base,
        status: 'sample',
        message:
          'An example row from the template. Skipped — type over it or delete it if you meant to add this item.',
      });
      sampleCount += 1;
      continue;
    }

    if (!rawName) {
      rows.push({
        ...base,
        message: 'This row has no item name, so there is nothing to create.',
      });
      errorCount += 1;
      continue;
    }

    // Cleaned, not merely trimmed — a name pasted out of another spreadsheet
    // routinely carries a double space, and storing it raw would create an item
    // the database sees as distinct from the one already there and a human sees
    // as the same. See cleanName.
    const name = cleanName(rawName);
    const code = rawCode.trim() || null;

    // --- duplicates WITHIN this file ---------------------------------------
    const nameKey = exactKey(name);
    const earlier = seenNames.get(nameKey);
    if (earlier !== undefined) {
      rows.push({
        ...base,
        status: 'duplicate',
        message: `“${name}” is already on row ${earlier} of this file. Only one row can create it.`,
      });
      duplicateCount += 1;
      continue;
    }
    if (code) {
      const earlierCode = seenCodes.get(code.toLowerCase());
      if (earlierCode !== undefined) {
        rows.push({
          ...base,
          status: 'duplicate',
          message: `The code “${code}” is already on row ${earlierCode} of this file. A code has to be unique.`,
        });
        duplicateCount += 1;
        continue;
      }
    }

    // --- duplicates against the CATALOGUE ----------------------------------
    const verdict = checkName(name, code, index);
    if (verdict.exact) {
      rows.push({
        ...base,
        status: 'duplicate',
        message: exactDuplicateMessage(verdict.exact),
      });
      duplicateCount += 1;
      continue;
    }
    if (verdict.codeClash) {
      rows.push({
        ...base,
        status: 'duplicate',
        message: codeClashMessage(verdict.codeClash),
      });
      duplicateCount += 1;
      continue;
    }

    // --- type ---------------------------------------------------------------
    const itemType = parseType(rawType);
    if (!itemType) {
      rows.push({
        ...base,
        message: rawType
          ? `“${rawType}” is not a type. Use one of: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}.`
          : `This row has no type. Use one of: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}.`,
      });
      errorCount += 1;
      continue;
    }

    // --- base unit -----------------------------------------------------------
    const unit = unitByCode.get(rawUnit.trim().toLowerCase());
    if (!unit) {
      rows.push({
        ...base,
        message: rawUnit
          ? `“${rawUnit}” is not one of your units. Use one of: ${activeUnitList || 'none set up yet'}.`
          : `This row has no base unit. Use one of: ${activeUnitList || 'none set up yet'}.`,
      });
      errorCount += 1;
      continue;
    }
    if (!unit.is_active) {
      rows.push({
        ...base,
        message: `The unit “${unit.unit_code}” is switched off. Turn it back on, or use a different unit.`,
      });
      errorCount += 1;
      continue;
    }

    // --- category (optional) -------------------------------------------------
    // An unknown category is an ERROR rather than a silent "no category" and
    // rather than a category created on the fly. Creating one would let a typo
    // in a spreadsheet quietly add "Grians" to the reporting structure every
    // report is grouped by; blanking it would lose a fact the user stated.
    let categoryId: string | null = null;
    let categoryName: string | null = null;
    if (rawCategory) {
      const found = categoryByName.get(rawCategory.trim().toLowerCase()) ?? [];
      if (found.length === 0) {
        rows.push({
          ...base,
          message: `There is no category called “${rawCategory}”. Add it on the Categories tab first, or clear this cell to leave the item uncategorised.`,
        });
        errorCount += 1;
        continue;
      }
      if (found.length > 1) {
        rows.push({
          ...base,
          message: `More than one category is called “${rawCategory}”. Rename one of them first.`,
        });
        errorCount += 1;
        continue;
      }
      categoryId = found[0].id;
      categoryName = found[0].name;
    }

    // --- reorder level (optional) --------------------------------------------
    let reorderLevel: number | null = null;
    if (rawReorder) {
      const parsed = parseQuantityCell(rawReorder);
      if (parsed === null) {
        rows.push({
          ...base,
          message: `“${rawReorder}” is not a number. Enter the reorder level in ${unit.unit_code}, or leave it blank.`,
        });
        errorCount += 1;
        continue;
      }
      if (parsed < 0) {
        rows.push({
          ...base,
          message: 'A reorder level cannot be negative. Leave it blank to not track it.',
        });
        errorCount += 1;
        continue;
      }
      reorderLevel = parsed;
    }

    // --- the standard field set (037), all optional --------------------------
    // A number that will not parse is reported rather than dropped: silently
    // ignoring a purchase cost somebody typed is how a user comes to believe a
    // figure was captured that never was.
    const optional = readOptionalFields(cells, map, unit.unit_code);
    if (optional.error) {
      rows.push({ ...base, message: optional.error });
      errorCount += 1;
      continue;
    }

    // --- accepted -------------------------------------------------------------
    const resolved: ProductPreviewRow = {
      ...base,
      ...optional.values,
      status: verdict.similar.length > 0 ? 'similar' : 'new',
      message:
        verdict.similar.length > 0 ? similarNamesMessage(verdict) : '',
      name,
      code,
      itemType,
      baseUnit: unit.unit_code,
      categoryId,
      categoryName,
      reorderLevel,
      similar: verdict.similar,
      similarTotal: verdict.similarTotal,
    };
    rows.push(resolved);
    if (resolved.status === 'similar') similarCount += 1;
    else newCount += 1;

    seenNames.set(nameKey, rowNumber);
    if (code) seenCodes.set(code.toLowerCase(), rowNumber);
    // Visible to every later row, so this file is checked against itself.
    index.push({ id: `row:${rowNumber}`, name, code, is_active: true });
  }

  return {
    rows,
    newCount,
    similarCount,
    duplicateCount,
    errorCount,
    sampleCount,
    sheetName: sheet.sheetName,
    format: sheet.format,
  };
}

function cell(cells: string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (cells[index] ?? '').trim();
}

// The 037 columns, read together because they fail the same way and share the
// same rule: blank means "not stated" (null), a value that will not parse is a
// per-row error naming the cell, and a negative is refused outright.
function readOptionalFields(
  cells: string[],
  map: ColumnMap,
  unitCode: string,
): {
  error?: string;
  values: {
    barcode: string | null;
    packSize: string | null;
    purchaseCost: number | null;
    minStockLevel: number | null;
    maxStockLevel: number | null;
  };
} {
  const blank = {
    barcode: null,
    packSize: null,
    purchaseCost: null,
    minStockLevel: null,
    maxStockLevel: null,
  };

  const number = (
    raw: string,
    label: string,
    hint: string,
  ): { error?: string; value: number | null } => {
    if (!raw) return { value: null };
    const parsed = parseQuantityCell(raw);
    if (parsed === null) {
      return { error: `“${raw}” is not a number. ${label} is ${hint}.`, value: null };
    }
    if (parsed < 0) {
      return { error: `${label} cannot be negative.`, value: null };
    }
    return { value: parsed };
  };

  const cost = number(
    cell(cells, map.purchaseCost),
    'Purchase cost',
    `what one ${unitCode} costs to buy`,
  );
  if (cost.error) return { error: cost.error, values: blank };

  const min = number(cell(cells, map.minStock), 'Min stock', `in ${unitCode}`);
  if (min.error) return { error: min.error, values: blank };

  const max = number(cell(cells, map.maxStock), 'Max stock', `in ${unitCode}`);
  if (max.error) return { error: max.error, values: blank };

  // 037 refuses a ceiling below its floor at the database; this is the wording
  // (rule 19 — the DB check is the guard, this is the sentence).
  if (min.value !== null && max.value !== null && max.value < min.value) {
    return { error: 'Max stock is below Min stock.', values: blank };
  }

  return {
    values: {
      barcode: cell(cells, map.barcode) || null,
      packSize: cell(cells, map.packSize) || null,
      purchaseCost: cost.value,
      minStockLevel: min.value,
      maxStockLevel: max.value,
    },
  };
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

export interface ProductCommitOutcome {
  rowNumber: number;
  name: string;
  ok: boolean;
  // True when the database refused it as an existing name/code — reported as
  // "already there", not as a failure, because that is what it means.
  alreadyExisted?: boolean;
  message?: string;
}

export interface ProductCommitResult {
  created: number;
  skipped: number;
  failed: number;
  outcomes: ProductCommitOutcome[];
}

export interface CommitProductsInput {
  tenantId: string;
  preview: ProductPreview;
  onProgress?: (done: number, total: number) => void;
}

// SEQUENTIAL, not concurrent, and that is a decision rather than an oversight.
// The opening-balance import runs four at a time because its rows are
// independent; these are not. Two rows of one file can be near-duplicates of
// each other, and the ONLY thing standing between them and two rows for one
// sack of rice is the unique index — which resolves races correctly but reports
// them as a 23505 on whichever row lost. Running in order means the losing row
// is always the later one, so the message a user reads ("row 40 already exists")
// matches the file they are looking at. A catalogue import is a few hundred
// rows once, so the wall-clock cost is not worth the confusion.
export async function commitProducts(
  input: CommitProductsInput,
): Promise<ProductCommitResult> {
  const creatable = input.preview.rows.filter(
    (r) => r.status === 'new' || r.status === 'similar',
  );
  const outcomes: ProductCommitOutcome[] = [];

  for (const [done, row] of creatable.entries()) {
    try {
      // Rule 11: awaited, in try/catch, and a failure is captured against its
      // own row rather than aborting the rest — a bad row 12 must not stop rows
      // 13 to 300 being created, and the user gets a per-row report either way.
      await createInventoryItem(input.tenantId, {
        name: row.name!,
        code: row.code ?? null,
        item_type: row.itemType!,
        base_unit: row.baseUnit!,
        category_id: row.categoryId ?? null,
        is_perishable: false,
        reorder_level: row.reorderLevel ?? null,
        barcode: row.barcode ?? null,
        pack_size: row.packSize ?? null,
        purchase_cost: row.purchaseCost ?? null,
        min_stock_level: row.minStockLevel ?? null,
        max_stock_level: row.maxStockLevel ?? null,
        is_active: true,
        // The catalogue lists alphabetically, so a new item needs no position;
        // display_order is reserved for later curated groupings.
        display_order: 0,
      });
      outcomes.push({ rowNumber: row.rowNumber, name: row.name!, ok: true });
    } catch (e) {
      const code = (e as { code?: string } | null)?.code;
      if (code === '23505') {
        // THE BACKSTOP FIRING, and the reason this is not an error. Either
        // somebody else created this name between the preview and now, or the
        // same file is being uploaded twice. Both mean the item exists, which
        // is the outcome the user wanted — so it is reported as skipped.
        outcomes.push({
          rowNumber: row.rowNumber,
          name: row.name!,
          ok: false,
          alreadyExisted: true,
          message: `“${row.name}” already exists in the catalogue, so it was left alone.`,
        });
      } else {
        outcomes.push({
          rowNumber: row.rowNumber,
          name: row.name!,
          ok: false,
          message: productErrorMessage(e),
        });
      }
    } finally {
      input.onProgress?.(done + 1, creatable.length);
    }
  }

  return {
    created: outcomes.filter((o) => o.ok).length,
    skipped: outcomes.filter((o) => o.alreadyExisted).length,
    failed: outcomes.filter((o) => !o.ok && !o.alreadyExisted).length,
    outcomes,
  };
}

// The per-row message for anything the unique index did not explain. Kept here
// rather than reusing humanizeError so a row-level failure reads as a sentence
// about THIS row.
function productErrorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string } | null;
  if (err?.code === '42501') {
    return 'You do not have permission to add items to this catalogue.';
  }
  if (err?.code === '23503') {
    return 'Its unit or category no longer exists. Reload the page and try again.';
  }
  return err?.message || 'It could not be created. Please try again.';
}
