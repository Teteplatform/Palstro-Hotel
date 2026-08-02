import { supabase } from './supabase';
import { fetchAllPaged } from './fetchAllPaged';
import { parseNumeric } from './format';
import type {
  GuestHistorySummary,
  GuestLedgerEntry,
  GuestStayRow,
} from '../types/guestLedger';

// Data layer for the guest-level surfaces (2.txt) over the two read views in
// migration 027.
//
// NOTHING HERE COMPUTES A FIGURE. The FIFO allocation and the cross-stay running
// balance are both computed by the database (027 §3, §4) for the reason 022 gives
// about tax: a second implementation of the rule, in another language, drifts
// from the first the day either changes, and the drift is silent. The only
// arithmetic in this file is the history SUMMARY, which adds up the very
// per-stay figures it is summarising — see fetchGuestHistorySummary.
//
// Compliance:
//   - Rule 19: RLS is the floor; every read is ALSO scoped to the active tenant
//     AND property. The guest row itself is tenant-scoped only (a guest is shared
//     across a tenant's properties — 014); their MONEY is property-scoped.
//   - Rule 1b: the stays list pages SERVER-SIDE via .range() with an exact count.
//   - Rule 20: the history summary spans the WHOLE set of the guest's stays, never
//     the visible page — a separate aggregate read, same scoping.
//   - Rule 1a: the aggregate and the ledger go through fetchAllPaged; nothing is
//     capped.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - §6: every numeric column arrives as a STRING — parse with parseNumeric
//     before any arithmetic or comparison.

// ---------------------------------------------------------------------------
// The stays table (rule 1b)
// ---------------------------------------------------------------------------

export interface GuestStaysPage {
  rows: GuestStayRow[];
  count: number; // exact total for this guest, not the page length
}

// One SERVER-PAGINATED page of a guest's stays at this property, newest arrival
// first — the same ordering the bookings list uses, so "most recent stay" is at
// the top where a returning guest is looked up.
//
// PAGING CANNOT CHANGE THE FIGURES. The FIFO allocation is a window function
// PARTITIONED BY (tenant, property, guest) inside the view (027 §3), computed
// over the guest's whole account before this .range() takes a slice of it — so
// page 2 shows the same allocation page 1 does, and a different sort order shows
// the same allocation again. That is the property a client-side allocation could
// not have.
export async function fetchGuestStaysPage(
  guestId: string,
  tenantId: string,
  propertyId: string,
  page: number,
  pageSize: number,
): Promise<GuestStaysPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const { data, error, count } = await supabase
    .from('guest_stays')
    .select('*', { count: 'exact' })
    .eq('guest_id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .order('check_in', { ascending: false })
    .order('booking_number', { ascending: false }) // unique → stable tiebreak
    .range(from, to)
    .returns<GuestStayRow[]>();

  if (error) throw error;
  return { rows: data ?? [], count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The history summary (rule 20 — spans every stay, not the page)
// ---------------------------------------------------------------------------

// "With us since", stays, nights, spent — across ALL of this guest's stays at
// this property. A SEPARATE read from the page, deliberately, so the strip can
// never be a page-derived figure dressed up as a lifetime one.
//
// THE ONLY CLIENT-SIDE ARITHMETIC IN THIS BUILD, and it is a sum of the very
// numbers printed in the table below it: each stay's charges_total,
// payments_total and balance come from folio_totals, and this adds them up. It
// cannot disagree with the ledger because the ledger's final running balance is
// the same difference computed by the database — see the invariant in
// types/guestLedger.ts.
export async function fetchGuestHistorySummary(
  guestId: string,
  tenantId: string,
  propertyId: string,
): Promise<GuestHistorySummary> {
  const rows = await fetchAllPaged<
    Pick<
      GuestStayRow,
      | 'check_in'
      | 'nights'
      | 'charges_total'
      | 'payments_total'
      | 'balance'
      | 'booking_number'
    >
  >((from, to) =>
    supabase
      .from('guest_stays')
      .select('check_in, nights, charges_total, payments_total, balance, booking_number')
      .eq('guest_id', guestId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .order('booking_number', { ascending: true }) // unique → stable pagination
      .range(from, to)
      .returns<
        Pick<
          GuestStayRow,
          | 'check_in'
          | 'nights'
          | 'charges_total'
          | 'payments_total'
          | 'balance'
          | 'booking_number'
        >[]
      >(),
  );

  let totalNights = 0;
  let totalCharged = 0;
  let totalPaid = 0;
  let outstanding = 0;
  let creditBalance = 0;
  let firstStay: string | null = null;
  let lastStay: string | null = null;

  for (const row of rows) {
    totalNights += row.nights ?? 0;
    totalCharged += parseNumeric(row.charges_total) ?? 0;
    totalPaid += parseNumeric(row.payments_total) ?? 0;

    // Outstanding and credit are accumulated SEPARATELY rather than netted, for
    // the same reason the bookings summary keeps them apart: a guest who owes
    // ₦100,000 on one stay and holds a ₦100,000 deposit on another is not
    // "settled", and a single net zero would report exactly that.
    const balance = parseNumeric(row.balance) ?? 0;
    if (balance > 0) outstanding += balance;
    else if (balance < 0) creditBalance += -balance;

    // 'YYYY-MM-DD' strings compare chronologically.
    if (firstStay === null || row.check_in < firstStay) firstStay = row.check_in;
    if (lastStay === null || row.check_in > lastStay) lastStay = row.check_in;
  }

  return {
    stayCount: rows.length,
    firstStay,
    lastStay,
    totalNights,
    totalCharged,
    totalPaid,
    outstanding,
    creditBalance,
  };
}

// ---------------------------------------------------------------------------
// The ledger (a STATEMENT, so it is never capped and never paged)
// ---------------------------------------------------------------------------

// Every ledger line for this guest at this property, business-date ordered with
// the running balance the database already computed.
//
// NOT PAGED, for the same reason lib/folio.ts does not page a bill: a statement
// that hides lines is not a statement, and this one is printed. fetchAllPaged
// keeps each REQUEST bounded (rule 1a) while still returning every row, so
// nothing is unreachable and no pager is needed — which is the distinction rule
// 1b draws. The stays TABLE beside it is a browse surface and is fully paged.
//
// The .order() here matches the view's own window ordering exactly. That is not
// decoration: running_balance is cumulative in THAT order, so printing the rows
// in any other order would show a balance column that does not add up.
export async function fetchGuestLedger(
  guestId: string,
  tenantId: string,
  propertyId: string,
): Promise<GuestLedgerEntry[]> {
  return fetchAllPaged<GuestLedgerEntry>((from, to) =>
    supabase
      .from('guest_ledger')
      .select('*')
      .eq('guest_id', guestId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .order('entry_date', { ascending: true }) // rule 8: business date
      .order('entry_rank', { ascending: true })
      .order('entry_created_at', { ascending: true })
      .order('booking_id', { ascending: true })
      .order('payment_id', { ascending: true, nullsFirst: true })
      .range(from, to)
      .returns<GuestLedgerEntry[]>(),
  );
}
