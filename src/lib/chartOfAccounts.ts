import { supabase } from './supabase';
import type { Account, AccountType } from '../types/accounting';

// THE CHART OF ACCOUNTS: its order, its sections, and the next free number
// (1.1h1). A pure module apart from the two writers at the bottom, so the render
// proof can exercise every rule without a browser.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ITS OWN FILE AND NOT MORE OF accounting.ts
// ---------------------------------------------------------------------------
// accounting.ts is about WHERE MONEY POSTS — role keys, mappings, the ledger's
// wiring. This is about THE LIST: what an accountant opens, prints and hands to
// an auditor. They are two objects, and conflating them is exactly the gap 1.1h
// shipped with — a mapping screen called the accounts screen.

// ---------------------------------------------------------------------------
// SECTION RANK — a CASE, never a column
// ---------------------------------------------------------------------------
// Five values, fixed by accounting rather than by a tenant, derivable from
// account_type in one expression. A stored column would be a second source of
// truth for something that cannot vary, and the first time the two disagreed the
// chart would be wrong with nothing erroring.
//
// THE ORDER IS THE STATEMENT ORDER, which is NOT alphabetical: assets,
// liabilities, equity, revenue, expenses. Sorting on account_type — which is
// what the database does unaided — gives asset, equity, expense, liability,
// revenue, stranding equity and expenses in the middle of the balance sheet.
//
// THE CODE RANGES are the thousand-blocks the seed uses. They are what makes
// ordering by (rank, code) reproduce the seeded sequence exactly — asserted in
// the 045 dry run across all 35 rows before display_order was dropped — and they
// are what suggestNextCode counts within.
export interface ChartSection {
  type: AccountType;
  rank: number;
  // What the screen calls it. 'revenue' stays the stored value; a Nigerian P&L
  // says "Revenue" at the top, so the label matches the column and no display
  // layer has to translate a perfectly good word.
  label: string;
  rangeStart: number;
  rangeEnd: number;
}

export const CHART_SECTIONS: ChartSection[] = [
  { type: 'asset',     rank: 1, label: 'Assets',      rangeStart: 1000, rangeEnd: 1999 },
  { type: 'liability', rank: 2, label: 'Liabilities', rangeStart: 2000, rangeEnd: 2999 },
  { type: 'equity',    rank: 3, label: 'Equity',      rangeStart: 3000, rangeEnd: 3999 },
  { type: 'revenue',   rank: 4, label: 'Revenue',     rangeStart: 4000, rangeEnd: 4999 },
  { type: 'expense',   rank: 5, label: 'Expenses',    rangeStart: 5000, rangeEnd: 5999 },
];

const BY_TYPE = new Map(CHART_SECTIONS.map((s) => [s.type, s]));

export function chartSection(type: AccountType): ChartSection {
  const s = BY_TYPE.get(type);
  // Unreachable while account_type's CHECK holds. If it ever is reached, a made-up
  // section is better than a crash on a settings screen — and it sorts last, where
  // it is visible rather than hidden between two real ones.
  return s ?? { type, rank: 99, label: type, rangeStart: 9000, rangeEnd: 9999 };
}

export function sectionRank(type: AccountType): number {
  return chartSection(type).rank;
}

// ---------------------------------------------------------------------------
// ORDER
// ---------------------------------------------------------------------------
// (section rank, code). No stored ordering, nothing to default, and an added
// account lands where its number says it belongs — which is what a numbered
// chart means and what an accountant expects.
//
// CODE IS COMPARED AS TEXT, not as a number, and that is deliberate: an account
// number is an identifier that happens to be digits. localeCompare with `numeric`
// keeps '1010' after '1000' and before '1200' while still doing the right thing
// if a chart ever holds '1000A' — which a real accountant's chart sometimes does.
export function sortChartOrder(rows: Account[]): Account[] {
  return [...rows].sort(
    (a, b) =>
      sectionRank(a.account_type) - sectionRank(b.account_type) ||
      a.code.localeCompare(b.code, undefined, { numeric: true }) ||
      a.name.localeCompare(b.name),
  );
}

export interface ChartGroup {
  section: ChartSection;
  rows: Account[];
}

// The chart as the screen renders it: sections in statement order, accounts in
// code order inside each.
//
// AN EMPTY SECTION IS DROPPED, not rendered as a heading with nothing under it.
// A tenant who has deactivated everything in Equity should see the rest of their
// chart, not a stub.
export function groupChart(rows: Account[]): ChartGroup[] {
  const sorted = sortChartOrder(rows);
  const groups: ChartGroup[] = [];
  for (const section of CHART_SECTIONS) {
    const inSection = sorted.filter((r) => r.account_type === section.type);
    if (inSection.length > 0) groups.push({ section, rows: inSection });
  }
  // Any account whose type is outside the five (impossible while the CHECK
  // holds) still reaches the screen rather than vanishing from it.
  const known = new Set(CHART_SECTIONS.map((s) => s.type));
  const strays = sorted.filter((r) => !known.has(r.account_type));
  if (strays.length > 0) {
    groups.push({ section: chartSection(strays[0].account_type), rows: strays });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// SEARCH
// ---------------------------------------------------------------------------
// CLIENT-SIDE, AND RULE 26 IS SATISFIED RATHER THAN IGNORED — the distinction is
// worth stating because it is the exact thing rule 26 forbids elsewhere.
//
// Rule 26's objection to a client-side filter is that it "searches what happened
// to be fetched, not what exists": the storekeeper types Zobo, item four hundred
// never arrived in the page, and the box says no matches for something on the
// shelf. That failure needs a PARTIAL fetch to happen.
//
// The chart is fetched WHOLE. fetchAllAccounts pages internally until the rows
// run out (rule 1a), so the set being filtered IS the set that exists. There is
// no page for a match to fall outside of. A server round-trip per keystroke here
// would buy nothing and cost a debounce.
//
// The moment that stops being true — if the chart ever grows past what is
// sensible to hold, or the fetch gains a cap — this becomes a server query like
// searchAccounts beside it.
export function chartSearchMatches(account: Account, term: string): boolean {
  const t = term.trim().toLowerCase();
  if (t === '') return true;
  return (
    account.code.toLowerCase().includes(t) ||
    account.name.toLowerCase().includes(t)
  );
}

export function filterChart(rows: Account[], term: string): Account[] {
  return rows.filter((r) => chartSearchMatches(r, term));
}

// ---------------------------------------------------------------------------
// THE NEXT FREE NUMBER
// ---------------------------------------------------------------------------
// A hotel should not have to know that a liability starts with 2. The form
// suggests, the form says which range it is suggesting within, and the person can
// still type their own.
//
// THE RULE: the lowest unused number in the section's block, stepping by 10 from
// the block start, falling back to +1 once the tens are exhausted. Ten-steps
// because that is how the seeded chart is spaced and how an accountant leaves
// room to insert later; +1 because a suggestion must always exist, and a full
// block should degrade rather than return nothing.
//
// IT CONSIDERS SOFT-DELETED CODES AS TAKEN. The unique index is partial
// (`where deleted_at is null`) so a removed code is legally reusable — but
// suggesting one silently reuses an account number that appears on last year's
// printed statements. Reuse stays possible by typing it; it is never the default.
export function suggestNextCode(
  existing: Pick<Account, 'code' | 'account_type'>[],
  type: AccountType,
): string {
  const section = chartSection(type);
  const taken = new Set(existing.map((a) => a.code));

  for (let n = section.rangeStart; n <= section.rangeEnd; n += 10) {
    if (!taken.has(String(n))) return String(n);
  }
  for (let n = section.rangeStart; n <= section.rangeEnd; n += 1) {
    if (!taken.has(String(n))) return String(n);
  }
  // A section with a thousand accounts in it. Return the block start; the unique
  // index will refuse the save and say so, which is better than inventing a
  // number outside the section's range.
  return String(section.rangeStart);
}

// Is this code inside the range its section claims? The form warns rather than
// refuses: an accountant with their own numbering scheme is not wrong, they just
// need to know the chart will sort their account where its number puts it.
export function codeIsInSection(code: string, type: AccountType): boolean {
  const n = Number(code);
  if (!Number.isInteger(n)) return false;
  const s = chartSection(type);
  return n >= s.rangeStart && n <= s.rangeEnd;
}

// A local duplicate check so the form can say so BEFORE the save fails. It is
// NOT the guard — accounts_code_uniq is, and it is what holds under two admins
// typing at once. This exists so the common case reads as a form validating
// itself rather than as a database rejecting you.
export function codeIsTaken(
  existing: Pick<Account, 'code'>[],
  code: string,
): boolean {
  return existing.some((a) => a.code === code.trim());
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------
// Direct to the table, as everywhere else in this module: 044's
// accounts_admin_insert / accounts_admin_update policies are the real
// enforcement, and 045's trigger owns the rules that survive a direct PATCH.
// Rule 11: awaited, wrapped, and the caller surfaces the error verbatim.

export interface NewAccount {
  name: string;
  account_type: AccountType;
  code: string;
  is_active: boolean;
}

export async function createAccount(
  tenantId: string,
  input: NewAccount,
): Promise<Account> {
  const { data, error } = await supabase
    .from('accounts')
    .insert({
      tenant_id: tenantId,
      code: input.code.trim(),
      name: input.name.trim(),
      account_type: input.account_type,
      is_active: input.is_active,
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as Account;
}

// Rename, renumber, or switch on and off. WHICH OF THOSE IS ALLOWED IS THE
// DATABASE'S DECISION, not this function's: 045's trigger freezes the code once
// the account has been posted to and refuses deactivation while a mapping points
// at it, each with its own message and hint. Nothing is pre-checked here, because
// a client-side copy of those rules is a second source of truth that drifts.
export async function updateAccount(
  accountId: string,
  patch: Partial<Pick<Account, 'code' | 'name' | 'is_active'>>,
): Promise<void> {
  const { error } = await supabase
    .from('accounts')
    .update(patch)
    .eq('id', accountId);
  if (error) throw error;
}
