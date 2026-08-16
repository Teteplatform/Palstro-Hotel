// Presentation helpers. NONE of these carry tenant content — the currency code,
// amounts, and counts all arrive from the database (rule 17). Only generic,
// non-tenant UI words ("adult", "children") live here.

// The single placeholder every formatter returns when it cannot produce a value
// (missing/unparseable input). An em dash reads as "no value" the way accounting
// reports use it; an empty string would render as a silent gap indistinguishable
// from a layout bug. Use this — never '' — anywhere a formatter has no value to
// show, so a missing number looks the same everywhere in the app (CLAUDE.md §6).
export const MISSING_VALUE = '—';

// Parse a Postgres numeric column into a JS number, or null when it is
// absent/unparseable.
//
// WHY THIS EXISTS: PostgREST returns numeric(p,s) columns as STRINGS (e.g.
// "4.3968311", "45000.00"), never JS numbers, to avoid the float precision loss
// a number would introduce. So `typeof col === 'number'` is always false and
// arithmetic/formatting on the raw value silently misbehaves. Every numeric
// column must be parsed explicitly here before any arithmetic, comparison, or
// Intl formatting — never rely on implicit coercion (CLAUDE.md §6, Money).
//
// Guards Number('') === 0 by rejecting empty/whitespace input, and NaN by
// requiring a finite result, so a bad value becomes null (caller decides the
// fallback) rather than a silent 0 or NaN.
export function parseNumeric(
  value: string | number | null | undefined,
): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

// Format a money amount in the property's own currency (e.g. NGN -> ₦45,000).
// Accepts the raw numeric column (string from PostgREST) or a number, and parses
// it through parseNumeric first. Rates are advertised in whole units, so fraction
// digits are dropped for a clean nightly price. An unknown currency code falls
// back to "CODE 45,000" rather than throwing; an unparseable amount yields the
// shared MISSING_VALUE dash, never a silent empty string.
export function formatCurrency(
  amount: number | string | null | undefined,
  currency: string,
): string {
  const value = parseNumeric(amount);
  if (value === null) return MISSING_VALUE;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  } catch {
    return `${currency} ${new Intl.NumberFormat().format(value)}`;
  }
}

// Format a money amount to the KOBO — two decimal places — in the property's own
// currency (e.g. NGN -> ₦68,360.00).
//
// WHY THIS EXISTS BESIDE formatCurrency: a nightly RATE is advertised in whole
// units, so formatCurrency drops the fraction digits for a clean price. A FOLIO is
// a bill, and a bill's printed lines must add up to its printed total. Tax lines
// are computed as round(net × rate, 2) by the database (021 §8.1), so ₦130,000 at
// 7.6% is ₦9,880.00 and a 0-dp display would round individual lines away until the
// column visibly failed to sum — the guest is holding the paper and can add it up.
// Every figure on a folio, an invoice or a receipt uses THIS formatter.
//
// Same contract as formatCurrency otherwise: parses the PostgREST numeric string
// explicitly, falls back to "CODE 1,234.00" for an unknown currency rather than
// throwing, and yields the shared MISSING_VALUE dash when there is no value.
export function formatMoney(
  amount: number | string | null | undefined,
  currency: string,
): string {
  const value = parseNumeric(amount);
  if (value === null) return MISSING_VALUE;
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  } catch {
    return `${currency} ${new Intl.NumberFormat(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value)}`;
  }
}

// A SIGNED quantity, for a ledger where direction is the whole point: "+40"
// adds, "-40" removes. A bare "40" is ambiguous in the one place ambiguity costs
// money.
//
// ----------------------------------------------------------------------------
// WHY THIS LIVES HERE, AND WHY IT DOES NOT READ THE RAW VALUE
// ----------------------------------------------------------------------------
// This replaces two identical private copies — one in StockItemLedger, one in
// MovementsList — that both did:
//
//     const formatted = formatQuantity(value);
//     return value.trim().startsWith('-') ? formatted : `+${formatted}`;
//
// and both CRASHED with "value.trim is not a function" the moment they were
// handed anything that was not a string.
//
// The defect was not the missing guard. It was that the function had ALREADY
// parsed the value into a number and then reached back past that parse to the
// unvalidated boundary value to ask a question — "is it negative?" — that the
// parsed number answers exactly. parseNumeric accepts string | number | null |
// undefined precisely because that is the range of shapes PostgREST emits
// (numeric arrives as a string, int8 and JSON nulls do not), and every other
// formatter here honours that. This one silently narrowed it back to `string`
// in its signature and trusted the narrowing at runtime.
//
// So the sign now comes from the parsed number. There is nothing left to guard,
// because there is nothing left that assumes a shape.
export function formatSignedQuantity(
  quantity: number | string | null | undefined,
): string {
  const value = parseNumeric(quantity);
  // Unparseable or absent renders as the shared dash, never as "+—" — a sign in
  // front of a missing value would read as a quantity of nothing.
  if (value === null) return MISSING_VALUE;
  const formatted = formatQuantity(value);
  // A negative value already carries its own minus from Intl; only a
  // non-negative one needs the plus added.
  return value < 0 ? formatted : `+${formatted}`;
}

// A quantity column (numeric(14,4) — four decimals, because recipe and bar
// measures are fractional). Trailing zeros are trimmed so a plain "2" does not
// render as "2.0000", while 0.025 kg survives intact.
export function formatQuantity(
  quantity: number | string | null | undefined,
): string {
  const value = parseNumeric(quantity);
  if (value === null) return MISSING_VALUE;
  return new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
  }).format(value);
}

// A tax rate stored as a FRACTION (numeric(5,4): '0.0750' = 7.5%) shown as a
// percentage. Trailing zeros trimmed, so 0.0750 reads "7.5%" and 0.0760 "7.6%".
export function formatRatePercent(
  rate: number | string | null | undefined,
): string {
  const value = parseNumeric(rate);
  if (value === null) return MISSING_VALUE;
  return `${new Intl.NumberFormat(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(value * 100)}%`;
}

// "2 adults · 1 child" — pluralised, children omitted when zero.
export function formatOccupancy(adults: number, children: number): string {
  const parts = [`${adults} ${adults === 1 ? 'adult' : 'adults'}`];
  if (children > 0) {
    parts.push(`${children} ${children === 1 ? 'child' : 'children'}`);
  }
  return parts.join(' · ');
}

// The first usable image URL from a room_types.images JSONB array. images is
// jsonb (rule §6: presentation data, never money), so it is validated defensively
// here — a malformed or empty array yields null and the caller shows a
// placeholder rather than a broken <img>.
export function firstImageUrl(images: unknown): string | null {
  if (!Array.isArray(images)) return null;
  const first = images.find(
    (x): x is string => typeof x === 'string' && x.trim().length > 0,
  );
  return first ?? null;
}
