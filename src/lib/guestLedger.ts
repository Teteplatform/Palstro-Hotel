import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary, passthrough } from './rowParse';
import type { Folio } from '../types/folio';
import type {
  GuestAccountSummary,
  GuestAccountSummaryRow,
  GuestLedgerEntry,
  GuestStayRow,
} from '../types/guestLedger';

// Data layer for the GUEST HOME (2.txt) over the read views in migration 028.
//
// NOTHING HERE COMPUTES A MONEY FIGURE, AND — SINCE 028 — NOTHING HERE SUMS ONE
// EITHER. The FIFO allocation, the cross-account running balance, the nights and
// now the SUMMARY are all computed by the database (028 §5–§8). The 027 version
// of this file added the summary up in the browser from a full fetch of the
// guest's stays; that is gone, for two reasons:
//   1. it could not see standalone items at all, so a guest's outstanding figure
//      would have silently excluded their non-resident tab;
//   2. rule 20 wants the figure computed across the whole filtered set, and one
//      aggregate read is the honest way to do that — a client-side sum over a
//      paged-through fetch is the same number by luck, not by construction.
//
// Compliance:
//   - Rule 19: RLS is the floor; every read is ALSO scoped to the active tenant
//     AND property. The guest row itself is tenant-scoped only (a guest is shared
//     across a tenant's properties — 014); their MONEY is property-scoped.
//   - Rule 1b: the stays list pages SERVER-SIDE via .range() with an exact count.
//   - Rule 20: the summary is a separate server-side aggregate over every stay
//     and every standalone item, never the visible page.
//   - Rule 1a: the ledger goes through fetchAllPaged; nothing is capped.
//   - Rule 11: every call is awaited and throws; the caller surfaces the error.
//   - Rule 24: every read parses its money at the boundary, so the running
//     balance a screen prints is the number the database computed.

// ---------------------------------------------------------------------------
// The stays table (rule 1b)
// ---------------------------------------------------------------------------

export interface GuestStaysPage {
  rows: GuestStayRow[];
  count: number; // exact total for this guest, not the page length
}

// One SERVER-PAGINATED page of a guest's stays at this property, newest arrival
// first — the same ordering the bookings list uses, so "most recent stay" is at
// the top where a returning guest is looked up (and where the checked-in stay
// whose kebab triggers checkout will be).
//
// PAGING CANNOT CHANGE THE FIGURES. The FIFO allocation is a window function
// PARTITIONED BY (tenant, property, guest) inside the view (028 §5), computed
// over the guest's whole account — stays and standalone items together — before
// this .range() takes a slice of it. So page 2 shows the same allocation page 1
// does, and a different sort order shows the same allocation again.
// ---------------------------------------------------------------------------
// The boundaries (rule 24) — completeness checked by the compiler
// ---------------------------------------------------------------------------

const stays = boundary<GuestStayRow>('guest_stays')(
  [
    'reserved_nights',
    'display_nights',
    'charges_total',
    'payments_total',
    'balance',
    'guest_charges_total',
    'guest_payments_pool',
    'charges_before',
    'allocated_amount',
    'unallocated_amount',
  ] as const,
  ['actual_nights'] as const,
);

const summaries = boundary<GuestAccountSummaryRow>('guest_account_summary')(
  [
    'stay_count',
    'standalone_count',
    'total_nights',
    'total_charged',
    'total_paid',
    'guest_balance',
    'outstanding',
    'credit_balance',
  ] as const,
  [] as const,
);

const ledgerEntries = boundary<GuestLedgerEntry>('guest_ledger')(
  ['entry_rank', 'charge_amount', 'payment_amount', 'running_balance'] as const,
  ['reserved_nights', 'actual_nights', 'display_nights'] as const,
);

const folios = passthrough<Folio>('folios');

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
  return { rows: stays.rows(data), count: count ?? 0 };
}

// ---------------------------------------------------------------------------
// The summary tiles (rule 20 — the whole account, never the page)
// ---------------------------------------------------------------------------

// ONE row, read from guest_account_summary (028 §7). Every figure — with us
// since, stays, nights, charged, paid, balance — is aggregated by the database
// across every stay AND every standalone item.
//
// A guest with no folio at this property yet has no row, which is not an error:
// they exist (the guest record is tenant-level) and simply have no account here.
// The empty summary below says exactly that, and the tiles render zeros rather
// than dashes over a "we could not load this" panic.
export async function fetchGuestAccountSummary(
  guestId: string,
  tenantId: string,
  propertyId: string,
): Promise<GuestAccountSummary> {
  const { data, error } = await supabase
    .from('guest_account_summary')
    .select('*')
    .eq('guest_id', guestId)
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .maybeSingle();

  if (error) throw error;

  const row = summaries.maybeRow(data);
  if (!row) {
    return {
      stayCount: 0,
      standaloneCount: 0,
      firstStay: null,
      lastStay: null,
      totalNights: 0,
      totalCharged: 0,
      totalPaid: 0,
      guestBalance: 0,
      outstanding: 0,
      creditBalance: 0,
    };
  }

  // Renamed, not re-parsed: the boundary did the parsing on the way in (rule
  // 24), so this is the view model taking the row's own numbers.
  return {
    stayCount: row.stay_count,
    standaloneCount: row.standalone_count,
    firstStay: row.first_stay,
    lastStay: row.last_stay,
    totalNights: row.total_nights,
    totalCharged: row.total_charged,
    totalPaid: row.total_paid,
    guestBalance: row.guest_balance,
    outstanding: row.outstanding,
    creditBalance: row.credit_balance,
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
// THE .order() HERE MATCHES THE VIEW'S OWN WINDOW ORDERING EXACTLY, and that is
// not decoration: running_balance is cumulative in THAT order, so printing the
// rows in any other order would show a balance column that does not add up.
// entry_key is the row's own id and makes the order total — without it two
// standalone charges on one day could swap between reads.
export async function fetchGuestLedger(
  guestId: string,
  tenantId: string,
  propertyId: string,
): Promise<GuestLedgerEntry[]> {
  return fetchAllPagedRows<GuestLedgerEntry>(ledgerEntries, (from, to) =>
    supabase
      .from('guest_ledger')
      .select('*')
      .eq('guest_id', guestId)
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .order('entry_date', { ascending: true }) // rule 8: business date
      .order('entry_rank', { ascending: true })
      .order('entry_created_at', { ascending: true })
      .order('entry_key', { ascending: true })
      .range(from, to)
      .returns<GuestLedgerEntry[]>(),
  );
}

// ---------------------------------------------------------------------------
// The standalone (non-resident) folio
// ---------------------------------------------------------------------------

// GET-OR-CREATE the guest's ONE standalone folio at this property (028 §2) — the
// folio that holds charges and payments not tied to any stay.
//
// WHY AN RPC AND NOT AN INSERT: folios has no write RLS policy for anyone, by
// design (021 §11), so every folio comes into being through a SECURITY DEFINER
// function. This one is get-or-create, guarded by the
// folios_guest_standalone_uniq partial unique index, so a guest can never end up
// with two non-resident tabs however many times the desk presses the button.
//
// It posts nothing. The charge or payment that follows goes through the
// unchanged post_charge / record_payment against the folio id returned here.
export async function openGuestFolio(
  tenantId: string,
  propertyId: string,
  guestId: string,
  idempotencyKey: string,
): Promise<Folio> {
  const { data, error } = await supabase.rpc('open_guest_folio', {
    p_tenant_id: tenantId,
    p_property_id: propertyId,
    p_guest_id: guestId,
    p_idempotency_key: idempotencyKey,
  });
  if (error) throw error;
  return folios.row(data);
}
