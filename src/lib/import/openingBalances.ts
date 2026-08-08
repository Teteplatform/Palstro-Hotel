import { createCategory, createInventoryItem, createUnit } from '../inventory';
import { ITEM_TYPES, itemTypeLabel } from '../inventoryLabels';
import {
  checkName,
  cleanName,
  codeClashMessage,
  exactKey,
  fetchNameIndex,
  type NameIndexEntry,
  type SimilarMatch,
} from '../inventoryDuplicates';
import { openingKey, postOpeningBalance, stockErrorMessage } from '../stock';
import { isSampleName } from './templateSamples';
import type { SheetData } from './readSheet';
import type {
  InventoryCategory,
  InventoryItem,
  ItemType,
  StockLocation,
  UnitDimension,
  UnitOfMeasure,
} from '../../types/inventory';

// ===========================================================================
// THE OPENING-STOCK SHEET: VALIDATE, CHOOSE, THEN COMMIT.
// ===========================================================================
//
// One file, both jobs — what the hotel stocks AND what is on the shelf (see
// openingTemplate.ts for why they were merged). So a row can do three things:
//
//   CREATE AN ITEM        the name is not in the catalogue.
//   POST AN OPENING       the Opening quantity is greater than zero.
//   BOTH                  a new item that already has stock, which is the
//                         normal case on day one.
//
// The engine underneath is untouched. Items are still ordinary admin-gated
// inserts (035) and the quantity is still post_opening_balance (036 §4.1) —
// once per item per location, idempotent on the file's own content hash. This
// module decides WHAT to call and in what order; it computes nothing about
// stock and values nothing.
//
// ----------------------------------------------------------------------------
// THE ONE RULE: NOTHING IS WRITTEN UNTIL EVERY ROW HAS BEEN CHECKED AND THE
// USER HAS SEEN THE RESULT — AND NOTHING IS CREATED BEHIND THEIR BACK.
// ----------------------------------------------------------------------------
// Validation is a PURE FUNCTION over the parsed sheet, the catalogue and the
// user's decisions. It touches no network and writes nothing.
//
// A value the tenant does not have — a unit "kilo", a category "Beverges" — is
// NEVER created silently. It is collected as a QUESTION, once per distinct
// value however many rows use it, and the user answers it: create it, or map it
// to one you already have. That is not politeness. A typo auto-created as a
// unit splits an item's stock and its future recipe measures into two
// incompatible scales, and 035 is explicit that the FK on unit_code exists to
// make 'kg' vs 'kgs' structurally impossible rather than a matter of
// data-entry discipline. Auto-creating from a spreadsheet would hand that
// discipline straight back to a typo. The same argument holds for a category,
// which is the grouping axis of every report this module exists to produce.
//
// A NAME THAT MERELY LOOKS LIKE ONE YOU HAVE is the same shape of question and
// gets the same treatment: create it as new, or use the existing item. Two rows
// for one sack of rice cannot be merged afterwards — their movements are
// permanent — so the only place to catch it is here, while a person is looking.
//
// ----------------------------------------------------------------------------
// IDEMPOTENCY — the part that stops a hotel double-loading its own stock
// ----------------------------------------------------------------------------
// Three layers, deliberately overlapping, because this is the one action whose
// failure mode is invisible (stock that looks plausible and is twice what is
// really on the shelf):
//
//   1. Each row's key is `open:<file fingerprint>:<location>:<item>` — derived
//      from the FILE'S OWN BYTES, never from a fresh batch id. Re-uploading the
//      same file replays every row: post_opening_balance finds the key and
//      returns the movement it already wrote (rules 2/3).
//   2. The key names the location and the item rather than the row NUMBER, so
//      re-ordering rows or inserting one at the top does not turn every row
//      into a new intent.
//   3. Underneath both, 036's stock_movements_one_opening_uniq allows exactly
//      ONE opening balance per item per location, whatever key is presented.
//   And for the item half: 035's unique index on lower(name) is the guard, so
//   commitOpeningSheet treats a 23505 as a NORMAL outcome ("already there") and
//   goes on to post the quantity against the item that already exists.
//
// This import writes OPENING movements only. ONGOING stock-in is a purchase
// receipt (tranche 2c) — not this sheet with bigger numbers, and the
// once-per-item guard makes sure it cannot become that.

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

// Headers are matched by NAME, not by position, so a user may reorder or delete
// columns they do not need. Each field lists the spellings people actually type.
//
// NOTE 'barcode' IS ITS OWN FIELD and is deliberately NOT an alias of `code`:
// 037 made them two different columns owned by two different parties (the
// hotel's own reference, and the manufacturer's), and folding one into the other
// would file a scanned EAN as the storekeeper's bin-card code.
const COLUMN_ALIASES: Record<string, string[]> = {
  name: ['item name', 'item', 'name', 'description', 'product', 'product name'],
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
  quantity: [
    'opening quantity',
    'opening stock',
    'quantity',
    'qty',
    'quantity on hand',
    'on hand',
    'stock',
  ],
  unitCost: ['unit cost', 'cost', 'cost per unit', 'unit price', 'price'],
  note: ['note', 'notes', 'comment', 'comments', 'remark', 'remarks'],
  // Kept for files produced by the previous build, which carried a Location
  // column. A row that names a location still goes there; every other row goes
  // to the location chosen on the screen. Honoured rather than ignored, because
  // silently overriding a location somebody wrote down would put stock in the
  // wrong store without a word.
  location: ['location', 'store', 'store/location', 'stock location'],
};

type ColumnMap = Partial<Record<keyof typeof COLUMN_ALIASES, number>>;

// A TRAILING PARENTHETICAL IS STRIPPED, which is what lets the template ship
// "Base unit (see Reference)" as a heading — the pointer belongs on the column
// it is about, and a header that then failed to match would be a self-inflicted
// wound. "(see Reference)", "(kg)", "(optional)" all fall away.
function normaliseHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find the header row and map each known field to its column index. The header
// is not assumed to be row 1: the CSV puts its reference lines above it, and
// people add a title row of their own.
function findHeader(
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
    // A row is THE header when it names an item column and an opening-quantity
    // column — the two without which this sheet has no job to do.
    if (map.name !== undefined && map.quantity !== undefined) {
      return { index: i, map };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Number parsing
// ---------------------------------------------------------------------------

// Spreadsheet cells arrive as text, and people type money the way they say it:
// "₦1,250.00", "1 250", "1.250,00". Read conservatively rather than cleverly,
// and documented so nobody has to guess:
//   * anything that is not a digit, separator or minus is stripped (currency
//     symbols, stray spaces, a trailing unit);
//   * when BOTH separators appear, the LAST one is the decimal point, which
//     handles "1,234.56" and "1.234,56" alike;
//   * a lone comma followed by exactly three digits is a thousands separator
//     ("1,500" = one thousand five hundred); otherwise it is a decimal point
//     ("0,25" = a quarter).
// The one genuinely ambiguous case — "0,250" meaning 0.25 in a locale that uses
// a comma decimal — reads as 250, which is why the sheet's guidance says to use
// a full stop for decimals. Made explicit rather than left to be discovered.
export function parseNumberCell(raw: string): number | null {
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

// Types are accepted as either the DB value ('raw') or the label a person reads
// on screen and on the Reference tab ('Ingredient'). Both are unambiguous.
function parseType(raw: string): ItemType | null {
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  const direct = ITEM_TYPES.find((t) => t === value);
  if (direct) return direct;
  const byLabel = ITEM_TYPES.find((t) => itemTypeLabel(t).toLowerCase() === value);
  if (byLabel) return byLabel;
  if (value === 'ingredient') return 'raw';
  if (value === 'sold as is' || value === 'sold as-is' || value === 'finished good') {
    return 'finished';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The decisions a user makes about values the catalogue does not have
// ---------------------------------------------------------------------------

// One decision per DISTINCT value, not per row: "kilo" appearing on forty rows
// is one question, asked once, answered once.
export type UnitDecision =
  | { action: 'create'; name: string; dimension: UnitDimension }
  | { action: 'map'; unitCode: string };

export type CategoryDecision =
  | { action: 'create' }
  | { action: 'map'; categoryId: string };

export type NameDecision =
  | { action: 'create' }
  | { action: 'use'; itemId: string };

export interface Resolutions {
  // Keyed by the CANONICAL form of what was typed — lowercased and trimmed —
  // so "Kilo" and "kilo " on two rows are one question.
  units: Record<string, UnitDecision>;
  categories: Record<string, CategoryDecision>;
  // Keyed by exactKey(name), the same expression 035's unique index uses.
  names: Record<string, NameDecision>;
}

export const NO_RESOLUTIONS: Resolutions = { units: {}, categories: {}, names: {} };

export function unitKey(raw: string): string {
  return raw.trim().toLowerCase();
}

export function categoryKey(raw: string): string {
  return raw.trim().toLowerCase();
}

// A question the preview puts in front of the user, with how many rows hang on
// it so the cost of getting it wrong is visible.
export interface UnknownValue {
  key: string;
  raw: string;
  rowCount: number;
}

export interface SimilarName {
  key: string;
  name: string;
  rowNumber: number;
  matches: SimilarMatch[];
  totalMatches: number;
}

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

// 'ready'  — green. Will import (create the item, post the quantity, or both).
// 'choose' — amber. A question is outstanding; the row imports once it is
//            answered, and not before.
// 'skip'   — grey. Nothing to do: already loaded, or a row with no quantity for
//            an item that already exists.
// 'error'  — red. The row cannot import and says exactly why.
export type OpeningRowStatus = 'ready' | 'choose' | 'skip' | 'error';

export interface OpeningPreviewRow {
  // The spreadsheet's OWN row number, so "row 47" on screen is row 47 in Excel.
  rowNumber: number;
  status: OpeningRowStatus;
  message: string;

  // What the user typed, echoed back so the preview is readable without the
  // file open beside it.
  rawItem: string;
  rawQuantity: string;
  rawUnitCost: string;

  // Resolved. `itemId` is set for an item that already exists (or one the user
  // chose to use); `createsItem` marks a row that will add one.
  itemId?: string;
  createsItem: boolean;
  name?: string;
  code?: string | null;
  itemType?: ItemType;
  baseUnit?: string;
  // The unit/category as TYPED, when the row depends on a pending decision.
  pendingUnit?: string;
  pendingCategory?: string;
  pendingName?: string;
  categoryId?: string | null;
  categoryCreateName?: string | null;
  // The other standard fields, read only for a row that creates its item.
  barcode?: string | null;
  packSize?: string | null;
  purchaseCost?: number | null;
  minStockLevel?: number | null;
  maxStockLevel?: number | null;
  reorderLevel?: number | null;

  locationId?: string;
  locationName?: string;
  // Undefined = no quantity given at all; 0 = "we hold none", stated.
  quantity?: number;
  unitCost?: number;
  note?: string | null;
  lineValue?: number;
}

export interface OpeningPreview {
  rows: OpeningPreviewRow[];
  readyCount: number;
  chooseCount: number;
  skipCount: number;
  errorCount: number;
  // Of the ready rows: how many add an item, and how many post a quantity.
  newItemCount: number;
  openingCount: number;
  // Value of the stock that WILL be loaded — the one figure that tells a
  // manager whether this file is roughly right before it is written.
  readyValue: number;
  // The outstanding questions, deduplicated across rows.
  unknownUnits: UnknownValue[];
  unknownCategories: UnknownValue[];
  similarNames: SimilarName[];
  sheetName: string;
  format: 'xlsx' | 'csv';
  // A fatal problem with the file as a whole. When set, nothing can be imported
  // and rows is empty.
  fatal?: string;
}

export interface ValidateOpeningInput {
  sheet: SheetData;
  // Every LIVE catalogue item — including switched-off ones, which still own
  // their names (035's unique index is partial on deleted_at, not on is_active).
  items: InventoryItem[];
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  locations: StockLocation[];
  // Where a row belongs when the sheet does not say — the location chosen on
  // the screen.
  defaultLocation: StockLocation;
  // (location, item) pairs that already carry an opening balance, from
  // fetchOpeningBalanceKeys. Those rows are SKIPPED with an explanation rather
  // than sent to the server to fail.
  existingOpenings: Set<string>;
  // What the user has decided so far about unknown units, unknown categories
  // and near-duplicate names. Pure input: re-validating with more answers is
  // how amber rows turn green.
  resolutions: Resolutions;
}

export function validateOpeningSheet(
  input: ValidateOpeningInput,
): OpeningPreview {
  const {
    sheet,
    items,
    units,
    categories,
    locations,
    defaultLocation,
    existingOpenings,
    resolutions,
  } = input;

  const empty = {
    rows: [],
    readyCount: 0,
    chooseCount: 0,
    skipCount: 0,
    errorCount: 0,
    newItemCount: 0,
    openingCount: 0,
    readyValue: 0,
    unknownUnits: [],
    unknownCategories: [],
    similarNames: [],
    sheetName: sheet.sheetName,
    format: sheet.format,
  };

  const header = findHeader(sheet.rows);
  if (!header) {
    return {
      ...empty,
      fatal:
        'This file has no header row naming an “Item name” column and an “Opening quantity” column. Download the sheet and use its headings.',
    };
  }
  const { index: headerIndex, map } = header;
  if (map.unitCost === undefined) {
    return {
      ...empty,
      fatal:
        'This file has no “Unit cost” column. An opening balance has to say what the stock is worth, so the cost cannot be left out.',
    };
  }

  // --- lookups -------------------------------------------------------------
  // Names and codes are matched case-insensitively, which means a name that
  // differs only by case is AMBIGUOUS and must be reported rather than resolved
  // arbitrarily — 035's unique indexes are on lower(name), so live duplicates
  // cannot exist, but a removed-and-recreated pair could.
  const byName = new Map<string, InventoryItem[]>();
  const byCode = new Map<string, InventoryItem[]>();
  const byId = new Map<string, InventoryItem>();
  for (const item of items) {
    push(byName, exactKey(item.name), item);
    if (item.code) push(byCode, item.code.trim().toLowerCase(), item);
    byId.set(item.id, item);
  }

  // Unit codes are stored canonically lowercase (035 constrains them), so "KG"
  // resolves to the existing 'kg' rather than being reported as unknown.
  const unitByCode = new Map(units.map((u) => [unitKey(u.unit_code), u]));
  const categoryByName = new Map<string, InventoryCategory[]>();
  for (const c of categories) push(categoryByName, categoryKey(c.name), c);

  const locationByName = new Map<string, StockLocation[]>();
  for (const l of locations) push(locationByName, l.name.trim().toLowerCase(), l);

  const nameIndex: NameIndexEntry[] = items.map((i) => ({
    id: i.id,
    name: i.name,
    code: i.code,
    is_active: i.is_active,
  }));

  // (location, item) pairs and names claimed EARLIER IN THIS FILE. Two rows for
  // one item is a mistake in the file, not two openings — and left unreported
  // the second would fail at the server after the first had written.
  const seenPairs = new Map<string, number>();
  const seenNames = new Map<string, number>();

  const unknownUnits = new Map<string, UnknownValue>();
  const unknownCategories = new Map<string, UnknownValue>();
  const similarNames = new Map<string, SimilarName>();

  const rows: OpeningPreviewRow[] = [];
  let readyCount = 0;
  let chooseCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  let newItemCount = 0;
  let openingCount = 0;
  let readyValue = 0;

  for (let i = headerIndex + 1; i < sheet.rows.length; i += 1) {
    const cells = sheet.rows[i];
    const rowNumber = i + 1; // 1-based, matching what Excel shows

    const rawName = cell(cells, map.name);
    const rawCode = cell(cells, map.code);
    const rawType = cell(cells, map.type);
    const rawUnit = cell(cells, map.baseUnit);
    const rawCategory = cell(cells, map.category);
    const rawQuantity = cell(cells, map.quantity);
    const rawUnitCost = cell(cells, map.unitCost);
    const rawLocation = cell(cells, map.location);
    const rawNote = cell(cells, map.note);

    const base: OpeningPreviewRow = {
      rowNumber,
      status: 'error',
      message: '',
      rawItem: rawName || rawCode,
      rawQuantity,
      rawUnitCost,
      createsItem: false,
    };

    // A COMPLETELY EMPTY ROW is not an error. The sheet ships one row per
    // catalogue item and a hotel leaves most of them blank — reporting three
    // hundred "errors" for the things they do not stock would bury the handful
    // that genuinely need attention.
    if (!rawName && !rawCode && !rawQuantity && !rawUnitCost) continue;

    // A row pasted out of the product template, still carrying its example
    // marker. Listed rather than dropped, so somebody who expected it to import
    // can see exactly what happened to it.
    if (isSampleName(rawName)) {
      rows.push({
        ...base,
        status: 'skip',
        message: 'An example row. Skipped — type over it if you meant it.',
      });
      skipCount += 1;
      continue;
    }

    if (!rawName && !rawCode) {
      rows.push({ ...base, message: 'This row has a quantity but no item name.' });
      errorCount += 1;
      continue;
    }

    // --- resolve the item ---------------------------------------------------
    let matches: InventoryItem[] = [];
    if (rawCode) matches = byCode.get(rawCode.trim().toLowerCase()) ?? [];
    if (matches.length === 0 && rawName) {
      matches = byName.get(exactKey(rawName)) ?? [];
    }
    if (matches.length > 1) {
      rows.push({
        ...base,
        message: `“${rawName || rawCode}” matches more than one item. Use the item code instead.`,
      });
      errorCount += 1;
      continue;
    }

    const name = cleanName(rawName);
    const code = rawCode.trim() || null;
    let existing: InventoryItem | null = matches[0] ?? null;
    let pendingName: string | undefined;

    // --- a name that LOOKS like one you have --------------------------------
    // Only asked for a row that would CREATE something. An exact match is not a
    // question — it is the sheet doing its job.
    if (!existing && name) {
      const verdict = checkName(name, code, nameIndex);
      if (verdict.codeClash) {
        rows.push({ ...base, message: codeClashMessage(verdict.codeClash) });
        errorCount += 1;
        continue;
      }
      if (verdict.similar.length > 0) {
        const key = exactKey(name);
        if (!similarNames.has(key)) {
          similarNames.set(key, {
            key,
            name,
            rowNumber,
            matches: verdict.similar,
            totalMatches: verdict.similarTotal,
          });
        }
        const decision = resolutions.names[key];
        if (!decision) {
          pendingName = name;
        } else if (decision.action === 'use') {
          const chosen = byId.get(decision.itemId) ?? null;
          if (!chosen) {
            rows.push({
              ...base,
              message: 'The item you chose is no longer in the catalogue. Reload and check again.',
            });
            errorCount += 1;
            continue;
          }
          existing = chosen;
        }
        // action 'create' falls through as a new item, which is what it means.
      }
    }

    // --- the item's details -------------------------------------------------
    // For a row that already has an item, every detail column is IGNORED: this
    // sheet loads quantities, it does not edit a catalogue. Said on the sheet
    // and again in the row's own status, rather than left to be discovered.
    let baseUnit: string | undefined = existing?.base_unit;
    let itemType: ItemType | undefined = existing?.item_type;
    let categoryId: string | null | undefined = existing?.category_id;
    let categoryCreateName: string | null = null;
    let pendingUnit: string | undefined;
    let pendingCategory: string | undefined;
    let rowError: string | null = null;

    if (!existing) {
      itemType = parseType(rawType) ?? undefined;
      if (!itemType) {
        rowError = rawType
          ? `“${rawType}” is not a type. Use one of: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}.`
          : `New item, so it needs a type: ${ITEM_TYPES.map(itemTypeLabel).join(', ')}.`;
      }

      // --- base unit ---
      if (!rowError) {
        if (!rawUnit) {
          rowError = 'New item, so it needs a base unit from the Reference list.';
        } else {
          const known = unitByCode.get(unitKey(rawUnit));
          if (known && known.is_active) {
            baseUnit = known.unit_code;
          } else if (known) {
            rowError = `The unit “${known.unit_code}” is switched off. Turn it back on, or use another.`;
          } else {
            const key = unitKey(rawUnit);
            const seen = unknownUnits.get(key);
            if (seen) seen.rowCount += 1;
            else unknownUnits.set(key, { key, raw: rawUnit.trim(), rowCount: 1 });

            const decision = resolutions.units[key];
            if (!decision) pendingUnit = rawUnit.trim();
            else if (decision.action === 'map') baseUnit = decision.unitCode;
            else baseUnit = key; // created at commit, canonically lowercased
          }
        }
      }

      // --- category (optional) ---
      if (!rowError && rawCategory) {
        const found = categoryByName.get(categoryKey(rawCategory)) ?? [];
        if (found.length > 1) {
          rowError = `More than one category is called “${rawCategory}”. Rename one first.`;
        } else if (found.length === 1) {
          categoryId = found[0].id;
        } else {
          const key = categoryKey(rawCategory);
          const seen = unknownCategories.get(key);
          if (seen) seen.rowCount += 1;
          else unknownCategories.set(key, { key, raw: rawCategory.trim(), rowCount: 1 });

          const decision = resolutions.categories[key];
          if (!decision) pendingCategory = rawCategory.trim();
          else if (decision.action === 'map') categoryId = decision.categoryId;
          else {
            categoryId = null;
            categoryCreateName = cleanName(rawCategory);
          }
        }
      } else if (!rowError) {
        categoryId = null;
      }
    }

    if (rowError) {
      rows.push({ ...base, message: rowError, createsItem: !existing });
      errorCount += 1;
      continue;
    }

    // --- duplicate rows within this file -----------------------------------
    // Checked on the NAME for a new item and on the (location, item) pair for
    // an existing one, below — a file naming the same new item twice would
    // otherwise create it once and fail confusingly on the second row.
    if (!existing) {
      const key = exactKey(name);
      const earlier = seenNames.get(key);
      if (earlier !== undefined) {
        rows.push({
          ...base,
          message: `“${name}” is already on row ${earlier} of this file. Combine the two rows.`,
        });
        errorCount += 1;
        continue;
      }
      seenNames.set(key, rowNumber);
    }

    // --- resolve the location ------------------------------------------------
    let location = defaultLocation;
    if (rawLocation) {
      const found = locationByName.get(rawLocation.trim().toLowerCase()) ?? [];
      if (found.length === 0) {
        rows.push({
          ...base,
          message: `This hotel has no stock location called “${rawLocation}”.`,
        });
        errorCount += 1;
        continue;
      }
      if (found.length > 1) {
        rows.push({
          ...base,
          message: `More than one location is called “${rawLocation}”. Rename one first.`,
        });
        errorCount += 1;
        continue;
      }
      location = found[0];
    }
    if (!location.is_active) {
      rows.push({
        ...base,
        message: `“${location.name}” is marked closed. Reopen it before loading stock into it.`,
      });
      errorCount += 1;
      continue;
    }

    // --- quantity -------------------------------------------------------------
    const unitLabel = baseUnit ?? 'the base unit';
    const quantity = parseNumberCell(rawQuantity);
    if (rawQuantity && quantity === null) {
      rows.push({
        ...base,
        message: `“${rawQuantity}” is not a number. Enter the quantity in ${unitLabel}.`,
      });
      errorCount += 1;
      continue;
    }
    if (quantity !== null && quantity < 0) {
      rows.push({
        ...base,
        message:
          'An opening balance cannot be negative. Load what is on the shelf, then correct it with an adjustment.',
      });
      errorCount += 1;
      continue;
    }

    // --- unit cost ------------------------------------------------------------
    const unitCost = parseNumberCell(rawUnitCost);
    if (rawUnitCost && unitCost === null) {
      rows.push({
        ...base,
        message: `“${rawUnitCost}” is not a number. Enter what one ${unitLabel} cost.`,
      });
      errorCount += 1;
      continue;
    }
    // A cost is required only when there is stock to value. 036 §4.1 refuses an
    // opening balance without one — it is the first movement of this item in
    // this location, so there is no average to fall back on.
    const wantsOpening = quantity !== null && quantity > 0;
    if (wantsOpening && unitCost === null) {
      rows.push({
        ...base,
        message: `This row has a quantity but no unit cost. Enter what one ${unitLabel} cost.`,
      });
      errorCount += 1;
      continue;
    }
    if (unitCost !== null && unitCost < 0) {
      rows.push({ ...base, message: 'A unit cost cannot be negative.' });
      errorCount += 1;
      continue;
    }

    // An item that is switched off cannot take an opening balance (036 §4.1
    // checks is_active). It can still sit in the sheet with no quantity.
    if (existing && !existing.is_active && wantsOpening) {
      rows.push({
        ...base,
        message: `“${existing.name}” is switched off. Turn it back on to load stock against it.`,
      });
      errorCount += 1;
      continue;
    }

    // --- the same item twice in one location ---------------------------------
    if (existing && wantsOpening) {
      const pairKey = openingKey(location.id, existing.id);
      const earlier = seenPairs.get(pairKey);
      if (earlier !== undefined) {
        rows.push({
          ...base,
          message: `“${existing.name}” in ${location.name} is already on row ${earlier}. Combine the two rows.`,
        });
        errorCount += 1;
        continue;
      }
      seenPairs.set(pairKey, rowNumber);

      if (existingOpenings.has(pairKey)) {
        rows.push({
          ...base,
          status: 'skip',
          name: existing.name,
          itemId: existing.id,
          locationId: location.id,
          locationName: location.name,
          message: `Already has an opening balance in ${location.name}. Left alone — correct it with an adjustment.`,
        });
        skipCount += 1;
        continue;
      }
    }

    // --- the resolved row ------------------------------------------------------
    const resolved: OpeningPreviewRow = {
      ...base,
      status: 'ready',
      message: '',
      itemId: existing?.id,
      createsItem: !existing,
      name: existing?.name ?? name,
      code: existing ? existing.code : code,
      itemType,
      baseUnit,
      pendingUnit,
      pendingCategory,
      pendingName,
      categoryId: categoryId ?? null,
      categoryCreateName,
      barcode: existing ? null : (cell(cells, map.barcode).trim() || null),
      packSize: existing ? null : (cell(cells, map.packSize).trim() || null),
      purchaseCost: existing ? null : parseNumberCell(cell(cells, map.purchaseCost)),
      minStockLevel: existing ? null : parseNumberCell(cell(cells, map.minStock)),
      maxStockLevel: existing ? null : parseNumberCell(cell(cells, map.maxStock)),
      reorderLevel: existing ? null : parseNumberCell(cell(cells, map.reorderLevel)),
      locationId: location.id,
      locationName: location.name,
      quantity: quantity ?? undefined,
      unitCost: unitCost ?? undefined,
      note: rawNote || null,
    };

    // A pending question outranks everything else the row could say: it will not
    // import, and the reason is a decision rather than a defect.
    const pending = pendingName ?? pendingUnit ?? pendingCategory;
    if (pending) {
      resolved.status = 'choose';
      resolved.message = pendingName
        ? `“${pendingName}” looks like something you already have — choose above.`
        : pendingUnit
          ? `“${pendingUnit}” is not one of your units — choose above.`
          : `“${pendingCategory}” is not one of your categories — choose above.`;
      rows.push(resolved);
      chooseCount += 1;
      continue;
    }

    // Nothing to do: an item that already exists, on a row with no quantity.
    if (!resolved.createsItem && !wantsOpening) {
      resolved.status = 'skip';
      resolved.message =
        quantity === 0
          ? 'Nothing on hand. Already in your catalogue, so nothing to do.'
          : 'No quantity given. Already in your catalogue, so nothing to do.';
      rows.push(resolved);
      skipCount += 1;
      continue;
    }

    if (wantsOpening) {
      resolved.lineValue = Math.round(quantity! * unitCost! * 100) / 100;
      readyValue += resolved.lineValue;
      openingCount += 1;
    }
    if (resolved.createsItem) newItemCount += 1;

    resolved.message = resolved.createsItem
      ? wantsOpening
        ? 'New item, with its opening stock'
        : 'New item, no opening stock'
      : 'Opening stock';

    rows.push(resolved);
    readyCount += 1;
  }

  return {
    rows,
    readyCount,
    chooseCount,
    skipCount,
    errorCount,
    newItemCount,
    openingCount,
    readyValue: Math.round(readyValue * 100) / 100,
    // Only the questions still worth asking about — a value used by rows that
    // all turned out to be errors is not a decision anyone needs to make.
    unknownUnits: [...unknownUnits.values()],
    unknownCategories: [...unknownCategories.values()],
    similarNames: [...similarNames.values()],
    sheetName: sheet.sheetName,
    format: sheet.format,
  };
}

function push<T>(map: Map<string, T[]>, key: string, value: T) {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

function cell(cells: string[], index: number | undefined): string {
  if (index === undefined) return '';
  return (cells[index] ?? '').trim();
}

// ---------------------------------------------------------------------------
// The commit
// ---------------------------------------------------------------------------

export interface OpeningCommitOutcome {
  rowNumber: number;
  itemName: string;
  locationName: string;
  ok: boolean;
  itemCreated: boolean;
  openingPosted: boolean;
  // The server's own message when something failed — shown verbatim, because
  // 035/036 raise sentences a storekeeper can act on.
  message?: string;
}

export interface OpeningCommitResult {
  itemsCreated: number;
  openingsPosted: number;
  unitsCreated: number;
  categoriesCreated: number;
  failed: number;
  outcomes: OpeningCommitOutcome[];
}

export interface CommitOpeningInput {
  tenantId: string;
  propertyId: string;
  preview: OpeningPreview;
  resolutions: Resolutions;
  // ISO yyyy-mm-dd. ONE business date for the whole file — the day the count was
  // taken — chosen on the screen, never per row (rules 8/12).
  businessDate: string;
  // The uploaded file's content fingerprint. See the header: this is what makes
  // re-uploading the same file a replay rather than a second load.
  fingerprint: string;
  // Called after each row so the screen can show progress on a 300-row file
  // instead of appearing to hang.
  onProgress?: (done: number, total: number) => void;
}

// SEQUENTIAL, not concurrent, and that is a decision rather than an oversight.
// Two rows of one file can be near-duplicates of each other, and the only thing
// standing between them and two rows for one sack of rice is 035's unique index
// — which resolves the race correctly but reports it as a 23505 against
// whichever row lost. Running in order means the losing row is always the LATER
// one, so "row 40 already exists" matches the file the user is looking at. A
// day-one load is a few hundred rows once; the wall-clock cost is not worth the
// confusion.
export async function commitOpeningSheet(
  input: CommitOpeningInput,
): Promise<OpeningCommitResult> {
  const ready = input.preview.rows.filter((r) => r.status === 'ready');
  const outcomes: OpeningCommitOutcome[] = [];

  // --- step 1: the reference values the user asked us to create ------------
  // Created ONCE each and before anything that depends on them, so forty rows
  // naming "crate" do not attempt forty units and collect thirty-nine 23505s.
  const createdUnits = new Map<string, string>(); // key -> unit_code
  const createdCategories = new Map<string, string>(); // key -> category id
  const referenceFailure = new Map<string, string>(); // key -> why
  let unitsCreated = 0;
  let categoriesCreated = 0;

  const neededUnitKeys = new Set(
    ready
      .filter((r) => r.createsItem && r.baseUnit)
      .map((r) => r.baseUnit as string)
      .filter((code) => input.resolutions.units[code]?.action === 'create'),
  );
  for (const key of neededUnitKeys) {
    const decision = input.resolutions.units[key];
    if (!decision || decision.action !== 'create') continue;
    try {
      const created = await createUnit(input.tenantId, {
        unit_code: key,
        name: decision.name,
        dimension: decision.dimension,
        display_order: 0,
      });
      createdUnits.set(key, created.unit_code);
      unitsCreated += 1;
    } catch (e) {
      // A 23505 here means somebody added the same unit between the preview and
      // now, which is the outcome that was wanted — the code exists, so rows
      // using it can go ahead.
      if ((e as { code?: string } | null)?.code === '23505') {
        createdUnits.set(key, key);
      } else {
        referenceFailure.set(`unit:${key}`, stockErrorMessage(e));
      }
    }
  }

  const neededCategoryKeys = new Set(
    ready
      .filter((r) => r.createsItem && r.categoryCreateName)
      .map((r) => categoryKey(r.categoryCreateName as string)),
  );
  for (const key of neededCategoryKeys) {
    const decision = input.resolutions.categories[key];
    if (!decision || decision.action !== 'create') continue;
    const row = ready.find(
      (r) => r.categoryCreateName && categoryKey(r.categoryCreateName) === key,
    );
    try {
      const created = await createCategory(input.tenantId, {
        name: row?.categoryCreateName ?? key,
        display_order: 0,
      });
      createdCategories.set(key, created.id);
      categoriesCreated += 1;
    } catch (e) {
      referenceFailure.set(`category:${key}`, stockErrorMessage(e));
    }
  }

  // --- step 2: the rows ----------------------------------------------------
  // A name index reloaded lazily, and only if a 23505 tells us somebody else
  // created an item between the preview and now — at which point we still want
  // to post the quantity against the item that DOES exist, rather than
  // abandoning the stock because the catalogue race went the other way.
  let freshIndex: NameIndexEntry[] | null = null;

  let done = 0;
  for (const row of ready) {
    let itemId = row.itemId ?? null;
    let itemCreated = false;
    let openingPosted = false;
    let failure: string | null = null;

    const label = row.name ?? row.rawItem;

    try {
      if (row.createsItem) {
        const unitFailure = referenceFailure.get(`unit:${row.baseUnit}`);
        const categoryFailure = row.categoryCreateName
          ? referenceFailure.get(`category:${categoryKey(row.categoryCreateName)}`)
          : undefined;
        if (unitFailure || categoryFailure) {
          throw new Error(
            `The new ${unitFailure ? 'unit' : 'category'} it needs could not be added: ${unitFailure ?? categoryFailure}`,
          );
        }

        const categoryId = row.categoryCreateName
          ? (createdCategories.get(categoryKey(row.categoryCreateName)) ?? null)
          : (row.categoryId ?? null);

        try {
          // rule 11: awaited, in try/catch, and a failure is captured against
          // its own row rather than aborting the rest.
          const created = await createInventoryItem(input.tenantId, {
            name: row.name!,
            code: row.code ?? null,
            item_type: row.itemType!,
            base_unit: createdUnits.get(row.baseUnit!) ?? row.baseUnit!,
            category_id: categoryId,
            is_perishable: false,
            reorder_level: row.reorderLevel ?? null,
            barcode: row.barcode ?? null,
            pack_size: row.packSize ?? null,
            purchase_cost: row.purchaseCost ?? null,
            min_stock_level: row.minStockLevel ?? null,
            max_stock_level: row.maxStockLevel ?? null,
            is_active: true,
            // The catalogue lists alphabetically, so a new item needs no
            // position; display_order is for later curated groupings.
            display_order: 0,
          });
          itemId = created.id;
          itemCreated = true;
        } catch (e) {
          if ((e as { code?: string } | null)?.code !== '23505') throw e;
          // THE BACKSTOP FIRING, and the reason this is not a failure: the item
          // exists, which is what the user wanted. Find it and carry on to the
          // quantity.
          if (freshIndex === null) freshIndex = await fetchNameIndex(input.tenantId);
          const key = exactKey(row.name!);
          const found = freshIndex.find((entry) => exactKey(entry.name) === key);
          if (!found) throw e;
          itemId = found.id;
        }
      }

      if (itemId && row.quantity !== undefined && row.quantity > 0) {
        await postOpeningBalance({
          propertyId: input.propertyId,
          locationId: row.locationId!,
          inventoryItemId: itemId,
          quantity: row.quantity,
          unitCost: row.unitCost!,
          businessDate: input.businessDate,
          note: row.note ?? null,
          // Content-derived, position-independent (see the header).
          idempotencyKey: `open:${input.fingerprint}:${row.locationId}:${itemId}`,
        });
        openingPosted = true;
      }
    } catch (e) {
      failure = rowErrorMessage(e);
    }

    outcomes.push({
      rowNumber: row.rowNumber,
      itemName: label,
      locationName: row.locationName ?? '',
      ok: failure === null,
      itemCreated,
      openingPosted,
      message: failure ?? undefined,
    });

    done += 1;
    input.onProgress?.(done, ready.length);
  }

  return {
    itemsCreated: outcomes.filter((o) => o.itemCreated).length,
    openingsPosted: outcomes.filter((o) => o.openingPosted).length,
    unitsCreated,
    categoriesCreated,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}

// The per-row message. 036 raises sentences a storekeeper can act on, so its own
// message is shown verbatim (stockErrorMessage) — but the ITEM half of this
// import writes straight to a table, and a table refuses in SQLSTATEs rather
// than in English. The two that a real user actually meets are named here.
//
// 42501 is the one worth spelling out: creating an item is admin-gated (035),
// posting stock is not, so a storekeeper uploading a sheet with new rows in it
// gets exactly this and needs to be told which half of the job was the problem —
// not "new row violates row-level security policy for table inventory_items".
function rowErrorMessage(e: unknown): string {
  const code = (e as { code?: string } | null)?.code;
  if (code === '42501') {
    return 'Only an owner can add new items to the catalogue. Its stock was not recorded either — ask an owner to load this row.';
  }
  if (code === '23503') {
    return 'Its unit or category no longer exists. Reload the page and check the file again.';
  }
  return stockErrorMessage(e);
}
