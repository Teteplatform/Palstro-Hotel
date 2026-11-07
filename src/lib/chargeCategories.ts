import { supabase } from './supabase';
import { boundary } from './rowParse';
import { fetchAllPagedRows } from './fetchAllPaged';
import { accountLabel } from './accounting';
import type { ChargeCategory } from '../types/folio';

// CHARGE CATEGORIES — what a hotel may bill for, and where each kind of money
// lands in the books (1.1h4 item 10).
//
// WHY THIS FILE EXISTS RATHER THAN MORE OF folio.ts: folio.ts owns the BILLING
// read — "what may I post right now" — which filters to active, undeleted rows
// because that is the front desk's menu. The settings screen needs the opposite
// read, inactive rows included, because a retired category is exactly what
// somebody opens the screen to look at. Two reads of one table with different
// filters belong apart, or the next person reuses the wrong one.
//
// AND THE PURE HELPERS BELOW ARE HERE SO THE RENDER PROOF CAN REACH THEM without
// a browser, the same reason chartOfAccounts.ts exists beside its tab.

// rule 24: display_order is the only numeric, and declaring it is the check —
// add a numeric column to the row type and this fails to compile, naming it.
const chargeCategories = boundary<ChargeCategory>('charge_categories')(
  ['display_order'] as const,
  [] as const,
);

// The one-off bucket. NAMED, not silent — see the note on orderOfferings below.
export const MISC_ROLE_KEY = 'revenue_misc';

// CONTRA-REVENUE, AND NOT A PLACE A CHARGE GOES. discounts_allowed is a
// revenue-type account by its sign and would otherwise be offered by the query
// below, which looks for revenue accounts rather than a hardcoded key list. A
// category pointed here would book its charges as relief given away.
export const NOT_A_CHARGE_DESTINATION = ['discounts_allowed'];

// How many options a picker returns before it says so (rule 26's announced cap).
const PICKER_LIMIT = 20;

// Keep a search term from being read as PostgREST filter syntax.
function safeTerm(term: string): string {
  return term.trim().replace(/[%,()]/g, '');
}

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

// EVERY category, active or not, deleted excluded (rule 5). Ordered the way the
// screen shows them, which is the order the billing menu uses too — so the
// person arranging them here sees what the desk will see.
export async function fetchAllChargeCategories(
  tenantId: string,
): Promise<ChargeCategory[]> {
  return fetchAllPagedRows<ChargeCategory>(chargeCategories, (from, to) =>
    supabase
      .from('charge_categories')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .is('deleted_at', null) // rule 5
      .order('display_order', { ascending: true })
      .order('name', { ascending: true })
      .range(from, to)
      .returns<ChargeCategory[]>(),
  );
}

export interface RevenueKeyOption {
  roleKey: string;
  accountCode: string;
  accountName: string;
}

// ---------------------------------------------------------------------------
// THE PICKER'S SEARCH
// ---------------------------------------------------------------------------
// WHAT A CATEGORY ACTUALLY CHOOSES IS A ROLE KEY, NOT AN ACCOUNT, and that is
// the whole reason this is not AccountPicker. The Accounts screen's own ⓘ says
// it: "Every posting names a role key … and the second tab is where each key is
// pointed at one of your accounts." A category names the key; the mapping names
// the account. Two screens, two jobs.
//
// So the picker shows BOTH — the key's label and the account it resolves to
// today — because picking "Miscellaneous" without seeing that it means "4100
// Other revenue" is the silent choice this shipment exists to end.
//
// IT OFFERS ONLY KEYS THAT RESOLVE TO A LIVE ACCOUNT. An unmapped key is
// refused by the trigger with PT424 on save, and a picker that offers a choice
// the database will refuse is the hint-names-the-wrong-remedy defect one layer
// up — the screen inviting what the server rejects.
//
// IT FINDS REVENUE KEYS BY THE ACCOUNT'S TYPE, not from a hardcoded key list.
// A tenant who adds revenue_spa and maps it appears here with no code change,
// which is the point of role keys; a hardcoded list would silently omit them
// and the category form would look like it did not support their own revenue.
//
// SERVER-SIDE (rule 26), against the same predicates the mapping tab's revenue
// group uses: tenant default mappings only (property_id null, as the trigger
// checks), live account, revenue type.
export async function searchRevenueRoleKeys(
  tenantId: string,
  term: string,
  options: { limit?: number } = {},
): Promise<{ rows: RevenueKeyOption[]; capped: boolean }> {
  const limit = options.limit ?? PICKER_LIMIT;

  let q = supabase
    .from('account_mappings')
    .select('role_key, account:accounts!inner(code, name, type, is_active, deleted_at)')
    .eq('tenant_id', tenantId) // rule 19
    .is('property_id', null) // the tenant default, which is what the trigger checks
    .eq('account.type', 'revenue')
    .eq('account.is_active', true)
    .is('account.deleted_at', null); // rule 5

  const safe = safeTerm(term);
  if (safe.length > 0) {
    // name and code, as rule 26 requires — plus the role key itself, because
    // somebody who has read a refusal naming "revenue_laundry" will type that.
    q = q.or(
      `role_key.ilike.%${safe}%,account.name.ilike.%${safe}%,account.code.ilike.%${safe}%`,
    );
  }

  const { data, error } = await q
    .order('role_key', { ascending: true })
    .range(0, limit); // limit + 1: the extra row is how the cap is noticed

  if (error) throw error;

  type Row = {
    role_key: string;
    account: { code: string; name: string } | { code: string; name: string }[] | null;
  };
  const rows: RevenueKeyOption[] = [];
  for (const raw of (data ?? []) as Row[]) {
    // PostgREST returns an embed as an object for a to-one relationship and an
    // array when it cannot tell; both are handled rather than assumed.
    const acct = Array.isArray(raw.account) ? raw.account[0] : raw.account;
    if (!acct) continue;
    if (NOT_A_CHARGE_DESTINATION.includes(raw.role_key)) continue;
    rows.push({
      roleKey: raw.role_key,
      accountCode: acct.code,
      accountName: acct.name,
    });
  }

  return {
    rows: orderOfferings(rows).slice(0, limit),
    capped: rows.length > limit,
  };
}

// MISC GOES LAST, ALWAYS, AND IT IS A RULE RATHER THAN A SIDE EFFECT.
//
// The seeded chart numbers Other revenue 4100, so ordering by account code
// already puts it at the bottom — but a tenant may renumber their chart freely
// (that is half the point of role keys), and then the one option that must never
// be offered first would drift up the list. So it is pushed to the end
// explicitly, and the two agree today rather than one depending on the other.
//
// WHY LAST AND NOT ABSENT: Miscellaneous is a NAMED BUCKET, deliberately
// chosen by a person, resolving to an account called Other revenue. That is not
// the silent default this shipment ends — a silent default is revenue landing
// where nobody chose. Deleting it would not remove the one-off charge; it would
// remove the honest place to put one, and the desk would bill it to Laundry at
// 11pm instead. A control that blocks legitimate work gets routed around.
export function orderOfferings(rows: RevenueKeyOption[]): RevenueKeyOption[] {
  return [...rows].sort((a, b) => {
    const aMisc = a.roleKey === MISC_ROLE_KEY ? 1 : 0;
    const bMisc = b.roleKey === MISC_ROLE_KEY ? 1 : 0;
    if (aMisc !== bMisc) return aMisc - bMisc;
    return a.accountCode.localeCompare(b.accountCode);
  });
}

// What one offering reads as in the panel: the account, then the key underneath.
export function revenueKeyLabel(option: RevenueKeyOption): string {
  return accountLabel({ code: option.accountCode, name: option.accountName });
}

// ---------------------------------------------------------------------------
// THE REVERSE DIRECTION, for the mapping tab
// ---------------------------------------------------------------------------
// WHICH CATEGORIES POST TO EACH KEY. The mapping tab answers "where does this
// kind of money go"; this answers "what arrives here", which is the question
// that makes a category quietly pointed at Other revenue VISIBLE instead of
// absent. Same rows, folded the other way — never a second query, so the two
// directions cannot disagree about the same category.
//
// A PURE FUNCTION so the render proof can exercise it: an inactive category
// still listed (it is still pointed here, and retiring it did not change that)
// and a key with no categories at all are both cases that would otherwise only
// ever be checked by looking at a screen.
export interface CategoriesForKey {
  active: ChargeCategory[];
  retired: ChargeCategory[];
}

export function categoriesByRoleKey(
  categories: ChargeCategory[],
): Map<string, CategoriesForKey> {
  const byKey = new Map<string, CategoriesForKey>();
  for (const c of categories) {
    const entry = byKey.get(c.account_role_key) ?? { active: [], retired: [] };
    (c.is_active ? entry.active : entry.retired).push(c);
    byKey.set(c.account_role_key, entry);
  }
  return byKey;
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------
// There is no RPC, deliberately. The table is written directly, the trigger
// guards it (068: who may, that a key is given, that the key is mapped) and RLS
// is the floor underneath. A write RPC here would be a fourth place to say the
// same rule — and rule 21 means this layer authors none of it: every refusal
// below arrives from the database and is rendered verbatim.

export interface NewChargeCategory {
  tenantId: string;
  code: string;
  name: string;
  isTaxable: boolean;
  serviceChargeable: boolean;
  accountRoleKey: string;
  displayOrder: number;
}

export async function createChargeCategory(
  input: NewChargeCategory,
): Promise<ChargeCategory> {
  const { data, error } = await supabase
    .from('charge_categories')
    .insert({
      tenant_id: input.tenantId,
      code: input.code,
      name: input.name,
      is_taxable: input.isTaxable,
      service_chargeable: input.serviceChargeable,
      account_role_key: input.accountRoleKey,
      display_order: input.displayOrder,
    })
    .select('*')
    .single();
  if (error) throw error;
  return chargeCategories.row(data);
}

export interface ChargeCategoryPatch {
  name?: string;
  isTaxable?: boolean;
  serviceChargeable?: boolean;
  accountRoleKey?: string;
  isActive?: boolean;
  displayOrder?: number;
}

export async function updateChargeCategory(
  id: string,
  patch: ChargeCategoryPatch,
): Promise<ChargeCategory> {
  const row: Record<string, unknown> = {};
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.isTaxable !== undefined) row.is_taxable = patch.isTaxable;
  if (patch.serviceChargeable !== undefined) {
    row.service_chargeable = patch.serviceChargeable;
  }
  if (patch.accountRoleKey !== undefined) row.account_role_key = patch.accountRoleKey;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  if (patch.displayOrder !== undefined) row.display_order = patch.displayOrder;

  const { data, error } = await supabase
    .from('charge_categories')
    .update(row)
    .eq('id', id)
    .select('*')
    .single();
  if (error) throw error;

  // AN UPDATE THAT MATCHED NOTHING IS NOT A SUCCESS, and before 068 that was
  // reachable: the admin test sat in the UPDATE policy's USING clause, so a
  // non-admin's edit was filtered to zero rows and returned 204. 068 moved the
  // test to WITH CHECK so the database refuses by name — and .single() above
  // turns "no row came back" into an error rather than a silent undefined, so
  // this layer cannot re-introduce the silence it was built to end.
  return chargeCategories.row(data);
}

// ---------------------------------------------------------------------------
// FORM HELPERS, pure
// ---------------------------------------------------------------------------

// The code is the stable machine key modules post against (see the type), so it
// is derived from the name once and then left alone — never re-derived on a
// rename, which would repoint every charge that ever used it.
export function suggestCode(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30);
}

export function codeIsTaken(existing: ChargeCategory[], code: string): boolean {
  const c = code.trim().toLowerCase();
  return existing.some((e) => e.code.toLowerCase() === c);
}

export function nextDisplayOrder(existing: ChargeCategory[]): number {
  return existing.reduce((max, e) => Math.max(max, e.display_order), 0) + 10;
}
