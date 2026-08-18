import { parseNumeric } from './format';

// ===========================================================================
// PARSE AT THE BOUNDARY (CLAUDE.md rule 24)
// ===========================================================================
//
// THE BUG THIS EXISTS TO END. Three identical crashes shipped in one day:
//
//     signedQuantity   in the item ledger        value.trim is not a function
//     counted_quantity in the count sheet        value.trim is not a function
//     row.quantity     in the adjustments list   row.quantity.trim is not a function
//
// One cause each time. A row type said `string`, PostgREST sent a JSON number,
// and a component called a string method on it. Fixing the third call site
// leaves a fourth waiting, because the call site was never the defect — the
// defect is that a raw wire value reached a component at all.
//
// WHAT THE WIRE ACTUALLY SENDS, which is why no single assumption is safe:
//
//     numeric(p,s)   -> STRING   "45000.00"   (PostgREST preserves the decimal)
//     int8 / bigint  -> NUMBER   1234         (JSON number, not a string)
//     int4 / float   -> NUMBER   12
//     NULL           -> null
//     an RPC's jsonb -> whatever the function built, which may be either
//
// A view can change a column's type between releases — casting a count to
// `integer` for the wire is a thing 039 does deliberately — and nothing in the
// client errors when it does. So the shape of a numeric on the wire is NOT a
// fact a component may depend on, and the row types must stop describing it.
//
// THE RULE. Every read that crosses from PostgREST into the app parses its
// numeric fields ONCE, here, into the type the app declares. After that
// boundary there is no raw PostgREST value left to get wrong: `quantity` is a
// `number`, so `.trim()` on it is a COMPILE error rather than a crash the
// storekeeper finds.
//
// ---------------------------------------------------------------------------
// WHY THE FIELD LISTS ARE CHECKED BY THE COMPILER
// ---------------------------------------------------------------------------
// A boundary that has to be REMEMBERED is the same defect one layer down: the
// next numeric column added to a row type would arrive unparsed and nothing
// would say so. So `boundary<T>()` demands EVERY numeric key of T, split by
// nullability, and the build fails until they are all listed:
//
//     Property '__unparsedNumericFields' is missing in type
//       'readonly ["quantity"]' but required in type
//       '{ __unparsedNumericFields: "seq"; }'
//
// which names the field that was forgotten. Add a numeric column to a type and
// the compiler sends you here before the screen can crash.
//
// ---------------------------------------------------------------------------
// WHY A MISSING REQUIRED NUMBER THROWS
// ---------------------------------------------------------------------------
// A field typed `number` (not `number | null`) is a not-null column. If one
// arrives absent or unparseable, the contract this module exists to keep is
// already broken, and the two alternatives are worse than throwing: a 0 is a
// wrong figure presented with confidence (the thing rule 20 is about), and a
// NaN spreads silently through every total it touches. Throwing surfaces it
// through the error path every fetch already has (rule 11), so the screen says
// it could not load rather than quietly lying. The message names the read and
// the field, because the only person who can act on it is a developer.

// ---------------------------------------------------------------------------
// Which keys of T are numbers, split by whether the type admits null
// ---------------------------------------------------------------------------

// Every key whose declared type is a number once null/undefined are stripped.
// `number[]` and `string` are not numbers and are correctly absent; a nullable
// `number | null` IS one, and is separated below rather than skipped.
type NumericKey<T> = {
  [K in keyof T]-?: NonNullable<T[K]> extends number ? K : never;
}[keyof T];

type NullableNumericKey<T> = {
  [K in NumericKey<T>]-?: null extends T[K] ? K : never;
}[NumericKey<T>];

type RequiredNumericKey<T> = Exclude<NumericKey<T>, NullableNumericKey<T>>;

// The exhaustiveness check. Resolves to `unknown` (an intersection that changes
// nothing) when every key is listed, and to an object with a required property
// — which no array literal has — when one is missing, so the error names it.
type AllListed<All extends PropertyKey, Listed extends PropertyKey> = [
  Exclude<All, Listed>,
] extends [never]
  ? unknown
  : { __unparsedNumericFields: Exclude<All, Listed> };

// ---------------------------------------------------------------------------
// The boundary
// ---------------------------------------------------------------------------

export interface RowBoundary<T> {
  // One row that must be there — an RPC's return, a single-row select.
  row(raw: unknown): T;
  // A list. Takes `data ?? []` straight from PostgREST.
  rows(raw: unknown): T[];
  // A .maybeSingle() result: the row, or null when there isn't one.
  maybeRow(raw: unknown): T | null;
}

// A value off the wire is `unknown` — it is whatever PostgREST serialised.
// Anything that is not a string or a number is not a number however it arrived,
// so it parses to null and the caller's nullability decides what that means.
// NOTE what this deliberately does NOT do: narrow its parameter back to
// `string`. That narrowing, trusted at runtime, is the whole bug class (rule
// 22's corollary).
function fromWire(value: unknown): number | null {
  if (typeof value === 'number' || typeof value === 'string') {
    return parseNumeric(value);
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'object') return Array.isArray(value) ? 'an array' : 'an object';
  return String(value);
}

// `name` is the READ, not the type — 'stock_movements', 'folio_totals'. It is
// the only thing in the thrown message that tells you where to look.
//
// Called in two steps so T is given explicitly and the key types can be
// inferred: boundary<StockMovement>('stock_movements')([...], [...]).
// Pass both lists `as const`, so the compiler sees the literal keys rather than
// a widened string[] and the exhaustiveness check has something to check.
// The parsing itself, with the key lists already settled. Everything above this
// point is about CHECKING those lists; this is the ten lines that do the work.
function makeBoundary<T>(
  name: string,
  requiredKeys: readonly string[],
  nullableKeys: readonly string[],
): RowBoundary<T> {
  function row(raw: unknown): T {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${name}: expected a row, received ${describe(raw)}.`);
    }
    const source = raw as Record<string, unknown>;
    // A shallow copy, so embeds and any column not listed here pass through
    // untouched — the boundary parses numbers, it does not curate the row.
    const parsed: Record<string, unknown> = { ...source };

    for (const key of requiredKeys) {
      const value = fromWire(source[key]);
      if (value === null) {
        throw new Error(
          `${name}.${key}: expected a number, received ${describe(source[key])}.`,
        );
      }
      parsed[key] = value;
    }
    for (const key of nullableKeys) {
      parsed[key] = fromWire(source[key]);
    }

    return parsed as T;
  }

  return {
    row,
    rows(raw: unknown): T[] {
      if (raw === null || raw === undefined) return [];
      if (!Array.isArray(raw)) {
        throw new Error(`${name}: expected a list, received ${describe(raw)}.`);
      }
      return raw.map(row);
    },
    maybeRow(raw: unknown): T | null {
      return raw === null || raw === undefined ? null : row(raw);
    },
  };
}

export function boundary<T>(name: string) {
  return function withNumericFields<
    R extends readonly RequiredNumericKey<T>[],
    N extends readonly NullableNumericKey<T>[],
  >(
    required: R & AllListed<RequiredNumericKey<T>, R[number]>,
    nullable: N & AllListed<NullableNumericKey<T>, N[number]>,
  ): RowBoundary<T> {
    return makeBoundary<T>(
      name,
      required as readonly string[],
      nullable as readonly string[],
    );
  };
}

// A row type with NO numeric field at all still crosses the boundary — a read
// that is exempt because somebody judged it exempt is how the next one gets
// missed. The second parameter is the proof: it is required ONLY when T turns
// out to have a numeric key, and it cannot be supplied, so
//
//     passthrough<StockMovement>('stock_movements')
//
// fails to compile and names `seq | quantity | unit_cost` as the reason. Use
// boundary() for those.
export function passthrough<T>(
  name: string,
  ...proofThereAreNoNumericFields: [NumericKey<T>] extends [never]
    ? []
    : [notNumberFree: { __unparsedNumericFields: NumericKey<T> }]
): RowBoundary<T> {
  void proofThereAreNoNumericFields;
  return makeBoundary<T>(name, [], []);
}

// ---------------------------------------------------------------------------
// The other shape a read comes in: a bare scalar
// ---------------------------------------------------------------------------

// An RPC that returns ONE numeric — resolve_booking_rate, count_available —
// answers with a value, not a row, so there is no row type to hang a boundary
// off. It is the same crossing and needs the same parse: a `returns numeric`
// function sends a string, a `returns integer` one sends a number, and which it
// is has never been visible from the call site.
//
// Returns null when the function answered NULL (no rate for that date), which
// is a real answer the caller must decide about — never a silent 0.
export function scalarNumber(value: unknown): number | null {
  return fromWire(value);
}
