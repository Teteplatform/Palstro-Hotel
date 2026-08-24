import { supabase } from './supabase';
import { boundary, passthrough } from './rowParse';
import { fetchAllPagedRows } from './fetchAllPaged';
import {
  PICKER_SEARCH_LIMIT,
  safeSearchTerm,
  type PickerSearchResult,
} from './inventory';
import type {
  Account,
  AccountMappingStatus,
} from '../types/accounting';

// THE LEDGER SPINE'S DATA LAYER (044).
//
// WHAT IS HERE AND WHAT IS DELIBERATELY NOT. This file reads the chart of
// accounts and the role-key mappings, and writes a mapping. IT DOES NOT READ THE
// LEDGER. There is no fetchJournalEntries, no trial balance, no account
// statement — every one of those is a REPORT and every one is stage 11. The test
// this shipment was scoped against: it gives money somewhere to go, it does not
// give anyone something to read.
//
// WRITES GO DIRECT TO THE TABLE, NOT THROUGH AN RPC, matching inventory.ts and
// roomTypes.ts and for the same reason: 044's is_tenant_admin() policies are the
// real enforcement, a mapping is admin-gated configuration, there is no money in
// the act and nothing to double-post. Rule 2's idempotency machinery exists to
// stop duplicate bookings, charges and payments; repointing a role key is none of
// those. Where this codebase DOES use an RPC it is because the server must hold a
// lock or stamp an actor under SECURITY DEFINER — post_journal is exactly that,
// and nothing in this file writes the ledger.

// ---------------------------------------------------------------------------
// Boundaries (rule 24)
// ---------------------------------------------------------------------------
// The declaration IS the check: boundary<T>() demands every numeric key of T,
// split by nullability, so adding a numeric column fails the build and names the
// field rather than shipping an unparsed value into a component.

// NO NUMERIC FIELDS AT ALL since 045 dropped display_order — `code` is TEXT, and
// deliberately so: an account number is an identifier that happens to be digits,
// not a quantity. Nothing adds it up, '1010' must never become 1010, and a
// leading zero in some future chart has to survive.
//
// passthrough<T>() rather than boundary<T>() with two empty lists, because it is
// the declaration that REFUSES TO COMPILE if Account ever gains a numeric field
// (rule 24 part 3). An empty boundary would silently keep accepting one.
const accounts = passthrough<Account>('accounts');

// line_count is int8 over PostgREST — a JSON NUMBER, not a string, unlike the
// numerics elsewhere in this app. It is declared here anyway, and that is the
// point of rule 24: the transport is decided by a cast inside a view and is
// invisible from the component, so no read is exempt by judgement.
const mappingStatus = boundary<AccountMappingStatus>('account_mapping_status')(
  ['line_count'] as const,
  [] as const,
);

// ---------------------------------------------------------------------------
// The chart of accounts
// ---------------------------------------------------------------------------

// Every live account for a tenant. The WHOLE set is consumed at once — it is the
// grouped list on the settings screen and the source for the picker's fallback —
// so this is fetchAllPaged (rule 1a) rather than a paged surface.
//
// INACTIVE ACCOUNTS ARE INCLUDED. A mapping pointing at a deactivated account
// still has to render its name, and resolve_account already refuses to post
// through one — hiding it here would leave the screen showing a blank where the
// explanation should be.
export async function fetchAllAccounts(tenantId: string): Promise<Account[]> {
  return fetchAllPagedRows<Account>(accounts, (from, to) =>
    supabase
      .from('accounts')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      // Ordered CLIENT-SIDE by (section rank, code) — see sortChartOrder. The
      // server can only sort account_type alphabetically, which puts equity and
      // expenses between assets and liabilities. A stable order here anyway, so
      // the paged fetch has a deterministic window.
      .order('code', { ascending: true })
      .range(from, to),
  );
}

// THE PICKER'S QUERY (rule 26). Server-side, against the same predicates
// fetchAllAccounts uses, so the picker's answer and the list's answer can never
// disagree. Matched on name AND code, because an accountant types "1300" and an
// owner types "inventory".
//
// A chart has thirty-odd rows today and a hotel group's will have three hundred,
// which is exactly the threshold rule 26 is about: judged by what the selector
// CAN hold, not by what today's data does.
export async function searchAccounts(
  tenantId: string,
  term: string,
  options: { limit?: number } = {},
): Promise<PickerSearchResult<Account>> {
  const limit = options.limit ?? PICKER_SEARCH_LIMIT;

  let q = supabase
    .from('accounts')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .is('deleted_at', null); // rule 5

  const safe = safeSearchTerm(term);
  if (safe.length > 0) {
    q = q.or(`name.ilike.%${safe}%,code.ilike.%${safe}%`);
  }

  const { data, error } = await q
    .order('code', { ascending: true })
    .order('id', { ascending: true }) // unique → a stable window
    .range(0, limit); // limit + 1 rows: the extra one reveals the cap

  if (error) throw error;
  const rows = accounts.rows(data);
  return { rows: rows.slice(0, limit), capped: rows.length > limit };
}

// ---------------------------------------------------------------------------
// The mappings
// ---------------------------------------------------------------------------

// Every mapping for a tenant, with its account and its derived last-posted date.
//
// BOTH SHAPES IN ONE READ: the tenant defaults (property_id null) and this
// property's overrides. The screen pairs them, so fetching them separately would
// mean two loading states for one table and a moment where a key appears
// unmapped because only half the rows had arrived.
export async function fetchMappingStatus(
  tenantId: string,
  propertyId: string,
): Promise<AccountMappingStatus[]> {
  return fetchAllPagedRows<AccountMappingStatus>(mappingStatus, (from, to) =>
    supabase
      .from('account_mapping_status')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .or(`property_id.is.null,property_id.eq.${propertyId}`)
      .order('role_key', { ascending: true })
      .range(from, to),
  );
}

// Repoint a role key at a different account.
//
// Rule 11: awaited, wrapped, and the error surfaced verbatim by the caller —
// never swallowed, and never re-worded (rule 21).
export async function setMappingAccount(
  mappingId: string,
  accountId: string,
): Promise<void> {
  const { error } = await supabase
    .from('account_mappings')
    .update({ account_id: accountId })
    .eq('id', mappingId);
  if (error) throw error;
}

// Add a PROPERTY OVERRIDE for a role key that currently uses the tenant default.
export async function addPropertyOverride(
  tenantId: string,
  propertyId: string,
  roleKey: string,
  accountId: string,
): Promise<void> {
  const { error } = await supabase.from('account_mappings').insert({
    tenant_id: tenantId,
    property_id: propertyId,
    role_key: roleKey,
    account_id: accountId,
  });
  if (error) throw error;
}

// Remove a property override, so the property returns to the tenant default.
//
// THIS IS THE ONLY DELETE IN THE MODULE, and it is why 044 grants a delete
// policy on account_mappings at all: removing the override is the only way to
// say "use the default again". There is no other verb for it.
export async function removePropertyOverride(mappingId: string): Promise<void> {
  const { error } = await supabase
    .from('account_mappings')
    .delete()
    .eq('id', mappingId);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Grouping for the screen
// ---------------------------------------------------------------------------

// The groups the Accounts tab renders, in the order it renders them, with the
// plain sentence that says what each is for.
//
// A ROLE KEY THAT IS NOT LISTED HERE STILL APPEARS, under "Other" — see
// groupMappings. That matters more than it looks: 1.1h2 and 1.1h3 add keys, a
// tenant may add their own, and a screen that silently dropped an unrecognised
// key would hide exactly the mapping somebody was looking for. The list decides
// ORDER and WORDING, never membership.
export interface MappingGroup {
  id: string;
  title: string;
  blurb: string;
  keys: string[];
}

export const MAPPING_GROUPS: MappingGroup[] = [
  {
    id: 'money',
    title: 'Money in and out',
    blurb: 'Where cash, transfers and card takings land.',
    keys: ['cash', 'bank', 'pos_clearing'],
  },
  {
    id: 'owed',
    title: 'What is owed to the hotel',
    blurb: 'Guests and companies with an unpaid balance.',
    keys: ['guest_ledger', 'company_receivable'],
  },
  {
    id: 'held',
    title: 'What the hotel holds',
    blurb: 'Stock and equipment the hotel owns.',
    keys: ['inventory', 'fixed_assets'],
  },
  {
    id: 'owes',
    title: 'What the hotel owes',
    blurb: 'Suppliers, tax collected, and the service charge.',
    keys: ['supplier_payable', 'vat_output', 'service_charge_payable'],
  },
  {
    id: 'revenue',
    title: 'Revenue',
    blurb: 'One account per charge category. A new category needs one before it can be charged.',
    keys: [
      'revenue_room',
      'revenue_fnb',
      'revenue_laundry',
      'revenue_internet',
      'revenue_minibar',
      'revenue_transport',
      'revenue_extra_bed',
      'revenue_early_checkin',
      'revenue_late_checkout',
      'revenue_damage',
      'revenue_misc',
      'discounts_allowed',
    ],
  },
  {
    id: 'losses',
    title: 'Stock corrections and losses',
    blurb: 'Adjustments, count variances, and each reason stock was written off.',
    keys: [
      'stock_adjustment',
      'stock_variance',
      'wastage_spoilage',
      'wastage_breakage',
      'wastage_expiry',
      'wastage_staff_meal',
      'wastage_complimentary',
    ],
  },
  {
    id: 'other',
    title: 'Other',
    blurb: 'Opening balances, and the rounding line.',
    keys: ['opening_balance_equity', 'rounding_difference'],
  },
];

// Human labels for the role keys. A key with no label shows its key, which is
// ugly and honest — better than a screen that invents a name for something it
// does not recognise.
export const ROLE_KEY_LABELS: Record<string, string> = {
  cash: 'Cash',
  bank: 'Bank',
  pos_clearing: 'Card takings (POS)',
  guest_ledger: 'Guest ledger',
  company_receivable: 'Company accounts',
  inventory: 'Stock on hand',
  fixed_assets: 'Fixed assets',
  supplier_payable: 'Suppliers',
  vat_output: 'VAT collected',
  service_charge_payable: 'Service charge',
  opening_balance_equity: 'Opening balances',
  revenue_room: 'Rooms',
  revenue_fnb: 'Food & Beverage',
  revenue_laundry: 'Laundry',
  revenue_internet: 'Internet',
  revenue_minibar: 'Minibar',
  revenue_transport: 'Transport',
  revenue_extra_bed: 'Extra bed',
  revenue_early_checkin: 'Early check-in',
  revenue_late_checkout: 'Late check-out',
  revenue_damage: 'Damage',
  revenue_misc: 'Miscellaneous',
  discounts_allowed: 'Discounts and comps',
  stock_adjustment: 'Stock adjustments',
  stock_variance: 'Count variances',
  wastage_spoilage: 'Spoilage',
  wastage_breakage: 'Breakage',
  wastage_expiry: 'Expiry',
  wastage_staff_meal: 'Staff meals',
  wastage_complimentary: 'Complimentaries',
  rounding_difference: 'Rounding',
};

export function roleKeyLabel(key: string): string {
  return ROLE_KEY_LABELS[key] ?? key;
}

// One row on the screen: a role key, the tenant default that applies to it, and
// this property's override if it has one.
export interface MappingRow {
  roleKey: string;
  fallback: AccountMappingStatus | null;
  override: AccountMappingStatus | null;
  // What actually resolves for this property — the override where there is one,
  // the default otherwise. Mirrors resolve_account exactly, and the render proof
  // asserts the two agree.
  effective: AccountMappingStatus | null;
}

export interface GroupedMappings {
  group: MappingGroup;
  rows: MappingRow[];
}

// Fold the view's rows into what the screen renders.
//
// EXTRACTED AS A PURE FUNCTION so the render proof can exercise the pairing
// without a browser: which mapping wins, what an unrecognised key does, and what
// "nothing has ever posted here" looks like are all decided here, and every one
// of them is a case that would otherwise only be checked by looking at a screen.
export function groupMappings(rows: AccountMappingStatus[]): GroupedMappings[] {
  const byKey = new Map<string, MappingRow>();

  for (const row of rows) {
    const existing = byKey.get(row.role_key) ?? {
      roleKey: row.role_key,
      fallback: null,
      override: null,
      effective: null,
    };
    if (row.property_id === null) existing.fallback = row;
    else existing.override = row;
    existing.effective = existing.override ?? existing.fallback;
    byKey.set(row.role_key, existing);
  }

  const claimed = new Set<string>();
  const groups: GroupedMappings[] = [];

  for (const group of MAPPING_GROUPS) {
    const groupRows: MappingRow[] = [];
    for (const key of group.keys) {
      const row = byKey.get(key);
      if (!row) continue; // a key this tenant has not mapped at all
      claimed.add(key);
      groupRows.push(row);
    }
    if (groupRows.length > 0) groups.push({ group, rows: groupRows });
  }

  // EVERY UNRECOGNISED KEY, rather than none. A tenant's own key, or one a later
  // shipment adds before this list catches up, must still be reachable — a
  // mapping the screen cannot show is a mapping nobody can change.
  const leftovers = [...byKey.values()]
    .filter((r) => !claimed.has(r.roleKey))
    .sort((a, b) => a.roleKey.localeCompare(b.roleKey));

  if (leftovers.length > 0) {
    const other = groups.find((g) => g.group.id === 'other');
    if (other) other.rows.push(...leftovers);
    else {
      groups.push({
        group: {
          id: 'other',
          title: 'Other',
          blurb: 'Keys this version does not have a description for.',
          keys: [],
        },
        rows: leftovers,
      });
    }
  }

  return groups;
}

// How many mappings have never had anything posted through them.
//
// THE SCREEN'S ONE SUMMARY FIGURE, and it earns a rule-16 note because it is not
// self-explanatory: a key nothing has posted to is either a module not wired yet
// (which is true of most of them until 1.1h2) or a genuine misconfiguration, and
// the screen cannot tell which. It says so rather than implying an alarm.
export function neverPostedCount(groups: GroupedMappings[]): number {
  return groups.reduce(
    (total, g) =>
      total +
      g.rows.filter((r) => r.effective !== null && r.effective.last_posted_on === null)
        .length,
    0,
  );
}

// How an account reads on screen: the number, then the name. Both, because an
// accountant matches on the number and an owner matches on the name.
//
// IT LIVES HERE AND NOT BESIDE AccountPicker, and the linter asked first — a
// non-component export in a component file trips react-refresh, and the honest
// response is to move it rather than add an error to a baseline. Same move
// stockChart.ts records. It also means the render proof can import the label
// without importing React.
export function accountLabel(account: { code: string; name: string }): string {
  return `${account.code} · ${account.name}`;
}
