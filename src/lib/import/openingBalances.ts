import type { InventoryItem, StockLocation } from '../../types/inventory';
import type { SheetData } from './readSheet';
import { openingKey, postOpeningBalance, stockErrorMessage } from '../stock';

// ===========================================================================
// THE OPENING-BALANCE SPREADSHEET: VALIDATE, THEN COMMIT.
// ===========================================================================
//
// How a hotel loads the stock it ALREADY HAS on the day it starts using the
// system. It is the one screen where a mistake is made three hundred rows at a
// time, so the whole design is one rule:
//
//   NOTHING IS WRITTEN UNTIL EVERY ROW HAS BEEN CHECKED AND THE USER HAS SEEN
//   THE RESULT.
//
// Validation is a pure function over the parsed sheet and the catalogue. It
// touches no network and writes nothing; it produces a per-row verdict — import
// this one, skip this one and here is why, reject this one and here is exactly
// what is wrong with it. Only after the user confirms does anything post.
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
//   2. The key includes the location and the item rather than the row NUMBER, so
//      re-ordering the rows or inserting one at the top does not turn every row
//      into a new intent.
//   3. Underneath both, 036's stock_movements_one_opening_uniq allows exactly
//      ONE opening balance per item per location, whatever key is presented. A
//      file re-saved by Excel (different bytes, different fingerprint) therefore
//      still cannot double-load — those rows come back as "already loaded".
//
// This import writes OPENING movements only. ONGOING stock-in is a purchase
// receipt (tranche 2c) — it is not a matter of re-uploading this sheet with
// bigger numbers, and the once-per-item guard makes sure it cannot be.

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

// Headers are matched by NAME, not by position, so a user may reorder or delete
// columns they do not need. Each field lists the spellings people actually type.
const COLUMN_ALIASES: Record<string, string[]> = {
  item: ['item', 'item name', 'name', 'description', 'product'],
  code: ['code', 'item code', 'sku', 'barcode'],
  location: ['location', 'store', 'store/location', 'stock location'],
  quantity: ['quantity', 'qty', 'quantity on hand', 'on hand', 'stock'],
  unitCost: ['unit cost', 'cost', 'cost per unit', 'unit price', 'price'],
  note: ['note', 'notes', 'comment', 'comments', 'remark', 'remarks'],
};

type ColumnMap = Partial<Record<keyof typeof COLUMN_ALIASES, number>>;

function normaliseHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Find the header row and map each known field to its column index. The header
// is not assumed to be row 1: people add a title row, or a blank line, above it.
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
    // A row is THE header when it names an item column and a quantity column —
    // the two without which there is nothing to import.
    if (map.item !== undefined && map.quantity !== undefined) {
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
// a comma decimal — reads as 250, which is why the screen's guidance says to use
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

// ---------------------------------------------------------------------------
// The preview
// ---------------------------------------------------------------------------

export type PreviewStatus = 'ready' | 'skip' | 'error';

export interface PreviewRow {
  // The spreadsheet's OWN row number, so "row 47" on screen is row 47 in Excel.
  rowNumber: number;
  status: PreviewStatus;
  // Exactly what is wrong (error) or why nothing will happen (skip). Empty for
  // a ready row.
  message: string;
  // What the user typed, echoed back so the preview is readable without the file
  // open beside it.
  rawItem: string;
  rawLocation: string;
  rawQuantity: string;
  rawUnitCost: string;
  // Resolved values, present only on a ready row.
  itemId?: string;
  itemName?: string;
  baseUnit?: string;
  locationId?: string;
  locationName?: string;
  quantity?: number;
  unitCost?: number;
  note?: string | null;
  lineValue?: number;
}

export interface Preview {
  rows: PreviewRow[];
  readyCount: number;
  skipCount: number;
  errorCount: number;
  // Value of everything that WILL be imported — the one figure that tells a
  // manager whether this file is roughly right before it is written.
  readyValue: number;
  sheetName: string;
  format: 'xlsx' | 'csv';
  // A fatal problem with the file as a whole (no header row, no quantity
  // column). When set, nothing can be imported and rows is empty.
  fatal?: string;
}

export interface ValidateInput {
  sheet: SheetData;
  items: InventoryItem[];
  locations: StockLocation[];
  // Where a row with a blank Location column belongs — the location the screen
  // is currently on.
  defaultLocation: StockLocation;
  // (location, item) pairs that already carry an opening balance, from
  // fetchOpeningBalanceKeys. Those rows are SKIPPED with an explanation rather
  // than sent to the server to fail.
  existingOpenings: Set<string>;
}

export function validateOpeningSheet(input: ValidateInput): Preview {
  const { sheet, items, locations, defaultLocation, existingOpenings } = input;

  const header = findHeader(sheet.rows);
  if (!header) {
    return {
      rows: [],
      readyCount: 0,
      skipCount: 0,
      errorCount: 0,
      readyValue: 0,
      sheetName: sheet.sheetName,
      format: sheet.format,
      fatal:
        'This file has no header row naming an “Item” column and a “Quantity” column. Download the template and use its headings.',
    };
  }
  const { index: headerIndex, map } = header;
  if (map.unitCost === undefined) {
    return {
      rows: [],
      readyCount: 0,
      skipCount: 0,
      errorCount: 0,
      readyValue: 0,
      sheetName: sheet.sheetName,
      format: sheet.format,
      fatal:
        'This file has no “Unit cost” column. An opening balance has to say what the stock is worth, so the cost cannot be left out.',
    };
  }

  // Lookups. Names and codes are matched case-insensitively (the brief), which
  // means a name that differs only by case is AMBIGUOUS and must be reported
  // rather than resolved arbitrarily — 035's unique indexes are on lower(name),
  // so live duplicates cannot exist, but a removed-and-recreated pair could.
  const byName = new Map<string, InventoryItem[]>();
  const byCode = new Map<string, InventoryItem[]>();
  for (const item of items) {
    push(byName, item.name.trim().toLowerCase(), item);
    if (item.code) push(byCode, item.code.trim().toLowerCase(), item);
  }
  const locationByName = new Map<string, StockLocation[]>();
  for (const loc of locations) {
    push(locationByName, loc.name.trim().toLowerCase(), loc);
  }

  // (location, item) pairs already claimed EARLIER IN THIS FILE. Two rows for the
  // same item in the same location is a mistake in the file, not two openings —
  // and left unreported the second would simply fail at the server after the
  // first had already been written.
  const seen = new Map<string, number>();

  const rows: PreviewRow[] = [];
  let readyCount = 0;
  let skipCount = 0;
  let errorCount = 0;
  let readyValue = 0;

  for (let i = headerIndex + 1; i < sheet.rows.length; i += 1) {
    const cells = sheet.rows[i];
    const rowNumber = i + 1; // 1-based, matching what Excel shows

    const rawItem = cell(cells, map.item);
    const rawCode = cell(cells, map.code);
    const rawLocation = cell(cells, map.location);
    const rawQuantity = cell(cells, map.quantity);
    const rawUnitCost = cell(cells, map.unitCost);
    const rawNote = cell(cells, map.note);

    const base: PreviewRow = {
      rowNumber,
      status: 'error',
      message: '',
      rawItem: rawItem || rawCode,
      rawLocation,
      rawQuantity,
      rawUnitCost,
    };

    // A COMPLETELY EMPTY ROW is not an error. The template ships one row per
    // catalogue item, and a hotel will leave most of them blank — reporting
    // three hundred "errors" for the items they do not stock would bury the
    // handful of rows that genuinely need attention.
    if (!rawItem && !rawCode && !rawQuantity && !rawUnitCost) {
      continue;
    }

    // A row with a name but nothing else is the same thing: an untouched
    // template line. Skipped silently rather than counted as a problem.
    if (!rawQuantity && !rawUnitCost) {
      continue;
    }

    // --- resolve the item ---------------------------------------------------
    let matches: InventoryItem[] = [];
    if (rawCode) matches = byCode.get(rawCode.trim().toLowerCase()) ?? [];
    if (matches.length === 0 && rawItem) {
      matches =
        byCode.get(rawItem.trim().toLowerCase()) ??
        byName.get(rawItem.trim().toLowerCase()) ??
        [];
    }

    if (matches.length === 0) {
      rows.push({
        ...base,
        message: rawItem || rawCode
          ? `No item called “${rawItem || rawCode}” is in the catalogue. Check the spelling, or add the item first.`
          : 'This row has a quantity but no item name.',
      });
      errorCount += 1;
      continue;
    }
    if (matches.length > 1) {
      rows.push({
        ...base,
        message: `“${rawItem || rawCode}” matches more than one item. Use the item code instead.`,
      });
      errorCount += 1;
      continue;
    }
    const item = matches[0];

    if (!item.is_active) {
      rows.push({
        ...base,
        message: `“${item.name}” is marked out of use in the catalogue. Turn it back on to load stock against it.`,
      });
      errorCount += 1;
      continue;
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
          message: `More than one location is called “${rawLocation}”. Rename one of them first.`,
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

    // --- quantity ------------------------------------------------------------
    const quantity = parseNumberCell(rawQuantity);
    if (rawQuantity && quantity === null) {
      rows.push({
        ...base,
        message: `“${rawQuantity}” is not a number. Enter the quantity in ${item.base_unit}.`,
      });
      errorCount += 1;
      continue;
    }
    if (quantity === null) {
      rows.push({
        ...base,
        message: `This row has a cost but no quantity. Enter how much ${item.name} is on hand, in ${item.base_unit}.`,
      });
      errorCount += 1;
      continue;
    }
    if (quantity <= 0) {
      rows.push({
        ...base,
        message:
          quantity === 0
            ? 'An opening balance of zero records nothing. Leave the row blank instead.'
            : 'An opening balance cannot be negative. Load what is on the shelf, then correct it with an adjustment if it is wrong.',
      });
      errorCount += 1;
      continue;
    }

    // --- unit cost -----------------------------------------------------------
    const unitCost = parseNumberCell(rawUnitCost);
    if (rawUnitCost && unitCost === null) {
      rows.push({
        ...base,
        message: `“${rawUnitCost}” is not a number. Enter what one ${item.base_unit} cost.`,
      });
      errorCount += 1;
      continue;
    }
    if (unitCost === null) {
      rows.push({
        ...base,
        message: `This row has no unit cost. Enter what one ${item.base_unit} of ${item.name} cost — it is what the stock on hand is worth.`,
      });
      errorCount += 1;
      continue;
    }
    if (unitCost < 0) {
      rows.push({ ...base, message: 'A unit cost cannot be negative.' });
      errorCount += 1;
      continue;
    }

    // --- duplicates and existing openings ------------------------------------
    const key = openingKey(location.id, item.id);

    const earlier = seen.get(key);
    if (earlier !== undefined) {
      rows.push({
        ...base,
        message: `“${item.name}” in ${location.name} is already on row ${earlier} of this file. Combine the two rows into one.`,
      });
      errorCount += 1;
      continue;
    }
    seen.set(key, rowNumber);

    if (existingOpenings.has(key)) {
      rows.push({
        ...base,
        status: 'skip',
        message: `“${item.name}” already has an opening balance in ${location.name}. It will be left alone — use an adjustment to correct it.`,
        itemName: item.name,
        locationName: location.name,
      });
      skipCount += 1;
      continue;
    }

    // --- ready ---------------------------------------------------------------
    const lineValue = Math.round(quantity * unitCost * 100) / 100;
    rows.push({
      ...base,
      status: 'ready',
      message: '',
      itemId: item.id,
      itemName: item.name,
      baseUnit: item.base_unit,
      locationId: location.id,
      locationName: location.name,
      quantity,
      unitCost,
      note: rawNote || null,
      lineValue,
    });
    readyCount += 1;
    readyValue += lineValue;
  }

  return {
    rows,
    readyCount,
    skipCount,
    errorCount,
    readyValue: Math.round(readyValue * 100) / 100,
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

export interface CommitOutcome {
  rowNumber: number;
  itemName: string;
  locationName: string;
  ok: boolean;
  // The server's own message when a row failed — shown verbatim, because 036
  // raises sentences a storekeeper can act on.
  message?: string;
}

export interface CommitResult {
  imported: number;
  failed: number;
  outcomes: CommitOutcome[];
}

export interface CommitInput {
  preview: Preview;
  propertyId: string;
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

// How many rows post at once. Sequential would take half a minute on a large
// catalogue and look broken; unbounded parallelism would open three hundred
// connections. Four is responsive and polite — and safe at any width, because
// every row carries its own idempotency key and the server is the one enforcing
// one-opening-per-item.
const COMMIT_CONCURRENCY = 4;

export async function commitOpeningBalances(
  input: CommitInput,
): Promise<CommitResult> {
  const ready = input.preview.rows.filter((r) => r.status === 'ready');
  const outcomes: CommitOutcome[] = new Array(ready.length);
  let done = 0;
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= ready.length) return;
      const row = ready[index];

      try {
        // Rule 11: awaited, and a failure is captured against its own row rather
        // than aborting the rest — a bad row 12 must not silently prevent rows
        // 13 to 300 from loading, and the user gets a per-row report either way.
        await postOpeningBalance({
          propertyId: input.propertyId,
          locationId: row.locationId!,
          inventoryItemId: row.itemId!,
          quantity: row.quantity!,
          unitCost: row.unitCost!,
          businessDate: input.businessDate,
          note: row.note ?? null,
          // Content-derived, position-independent (see the header).
          idempotencyKey: `open:${input.fingerprint}:${row.locationId}:${row.itemId}`,
        });
        outcomes[index] = {
          rowNumber: row.rowNumber,
          itemName: row.itemName ?? row.rawItem,
          locationName: row.locationName ?? '',
          ok: true,
        };
      } catch (e) {
        outcomes[index] = {
          rowNumber: row.rowNumber,
          itemName: row.itemName ?? row.rawItem,
          locationName: row.locationName ?? '',
          ok: false,
          message: stockErrorMessage(e),
        };
      } finally {
        done += 1;
        input.onProgress?.(done, ready.length);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(COMMIT_CONCURRENCY, ready.length) }, worker),
  );

  return {
    imported: outcomes.filter((o) => o.ok).length,
    failed: outcomes.filter((o) => !o.ok).length,
    outcomes,
  };
}
