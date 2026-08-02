import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError } from '../../../lib/errors';
import { useGuestAccount } from '../../../hooks/useGuestAccount';
import { GuestProfileHeader } from './GuestProfileHeader';
import { GuestSummaryTab } from './GuestSummaryTab';
import { GuestLedger } from './GuestLedger';

// THE GUEST HOME (2.txt §2) — route /admin/:propertySlug/guests/:guestId.
//
// ---------------------------------------------------------------------------
// THIS PAGE IS NOW THE SINGLE HOME FOR EVERYTHING ABOUT A PERSON.
// ---------------------------------------------------------------------------
// A guest's information used to be split across three surfaces: the booking
// page's Guest Details tab (identity, editable), the booking page's Stay tab
// (that one stay), and this page (history and ledger). Two of those held an
// EDITABLE copy of the same guest record, which is the shape that eventually
// produces two different phone numbers for one person and no way to tell which
// is current.
//
// So the booking page's Guest Details tab is GONE, not duplicated — the guest
// record is edited here and nowhere else — and the booking page keeps only what
// is genuinely about the STAY (its reservation facts and its bill), reachable by
// drilling into a row of the stays table below. The bookings LIST is untouched:
// it is the entry point, a hotel may accumulate thousands of bookings over
// years, and that is exactly what a paged list is for.
//
// A ROUTE, NOT A PANEL, for the reasons the booking page gives: it can be linked
// to, refreshed into, shared with a manager and — the one that matters here —
// PRINTED. The active tab lives in the URL as ?tab= with replace: true, so a
// refresh returns to the same view and Back goes where the user expects rather
// than through every tab they looked at. No browser storage anywhere.
//
// TWO TABS, TWO QUESTIONS:
//   Summary — how does this account stand RIGHT NOW: the six figures and the
//             stays, with every per-stay action on the row's kebab.
//   Ledger  — one running statement across the whole account, bank-statement
//             style, printable.
//
// THE PROFILE HEADER IS OUTSIDE BOTH so a printed statement identifies the guest.

const TABS = [
  { id: 'summary', label: 'Summary' },
  { id: 'ledger', label: 'Ledger' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function toTabId(value: string | null): TabId {
  // 'history' is the tab this page used to open on. Links to it exist in
  // people's browser history and in messages already sent to colleagues, so it
  // resolves to its replacement rather than silently falling back — the rename
  // was "this is a snapshot, not a record of the past", not a different view.
  if (value === 'history') return 'summary';
  return TABS.some((t) => t.id === value) ? (value as TabId) : 'summary';
}

interface GuestDetailScreenProps {
  guestId: string;
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  propertyName: string;
  currency: string;
  // The PROPERTY's IANA timezone. Load-bearing, not cosmetic: a charge or
  // payment keyed here defaults to the HOTEL's operating day, and the server
  // derives the same business date from the same zone (rules 8, 12).
  timezone: string;
  // Whether this user is an owner/manager of the tenant that owns this property.
  // The guest-correction path is admin-only at the database (see updateGuest).
  isAdmin: boolean;
}

export function GuestDetailScreen({
  guestId,
  tenantId,
  propertyId,
  propertySlug,
  propertyName,
  currency,
  timezone,
  isAdmin,
}: GuestDetailScreenProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = toTabId(searchParams.get('tab'));
  const navigate = useNavigate();

  const account = useGuestAccount(guestId, tenantId, propertyId);
  const { guest, notFound, error } = account;

  function selectTab(next: TabId) {
    setSearchParams({ tab: next }, { replace: true });
  }

  // A stay's drill-in is its BILL — the itemised SN / Date / Type / Description
  // / Amount page. That is what this screen does NOT hold and what a reader wants
  // next from a statement line or a stays row, so the link carries the hash that
  // lands them on it rather than at the top of the reservation panel above it.
  function openStay(bookingId: string) {
    navigate(`/admin/${propertySlug}/bookings/${bookingId}#booking-folio`);
  }

  // THE GUEST-FACING STATEMENT (3.txt) — the printable bill for ONE stay, as
  // opposed to openStay's internal folio. Both are reachable from the same
  // kebab, deliberately: the desk needs the working document while the guest is
  // at the counter and the clean one to hand over, and making them two menu
  // items with two plain names is how a receptionist tells them apart at 02:00.
  function openStayStatement(bookingId: string) {
    navigate(`/admin/${propertySlug}/bookings/${bookingId}/statement`);
  }

  // The same document for the guest's NON-RESIDENT account (028 §2) — their
  // charges and payments that belong to no stay. It adapts: no room, no dates,
  // no nights.
  function openStandaloneStatement() {
    navigate(`/admin/${propertySlug}/guests/${guestId}/statement`);
  }

  const backHref = `/admin/${propertySlug}/bookings`;

  return (
    <div className="mx-auto max-w-5xl">
      <Link
        to={backHref}
        className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream print:hidden"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        Back to bookings
      </Link>

      {error ? (
        <div className="mt-4 rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
          <p className="text-sm font-medium text-charcoal">
            We couldn’t load this guest.
          </p>
          {/* Rule 11: the REAL diagnostic. */}
          <p className="mt-1 text-sm text-charcoal-muted">{describeError(error)}</p>
          <button
            type="button"
            onClick={() => void account.reload()}
            className="mt-4 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Try again
          </button>
        </div>
      ) : notFound ? (
        <p className="mt-4 rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
          This guest could not be found in this tenant. They may have been
          removed, or the link may belong to a different hotel.
        </p>
      ) : guest ? (
        <>
          <GuestProfileHeader
            guest={guest}
            tenantId={tenantId}
            canEdit={isAdmin}
            onGuestChanged={account.reload}
          />

          <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0 print:hidden">
            <div
              role="tablist"
              aria-label="Guest views"
              className="flex min-w-max gap-1 border-b border-sand-border"
            >
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  aria-controls={`guest-panel-${t.id}`}
                  id={`guest-tab-${t.id}`}
                  onClick={() => selectTab(t.id)}
                  className={`-mb-px whitespace-nowrap rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                    tab === t.id
                      ? 'border-primary text-charcoal'
                      : 'border-transparent text-charcoal-muted hover:text-charcoal'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>

          <div className="mt-5">
            {tab === 'summary' ? (
              <div
                role="tabpanel"
                id="guest-panel-summary"
                aria-labelledby="guest-tab-summary"
              >
                <GuestSummaryTab
                  guestId={guestId}
                  guestName={guest.full_name}
                  tenantId={tenantId}
                  propertyId={propertyId}
                  summary={account.summary}
                  summaryLoading={account.summaryLoading}
                  stays={account.stays}
                  count={account.count}
                  page={account.page}
                  pageSize={account.pageSize}
                  loading={account.loading}
                  currency={currency}
                  timezone={timezone}
                  onPageChange={account.setPage}
                  onPageSizeChange={account.setPageSize}
                  onOpenStay={openStay}
                  onOpenStayStatement={openStayStatement}
                  onOpenStandaloneStatement={openStandaloneStatement}
                  onAccountChanged={account.reload}
                />
              </div>
            ) : null}

            {tab === 'ledger' ? (
              <div
                role="tabpanel"
                id="guest-panel-ledger"
                aria-labelledby="guest-tab-ledger"
              >
                {/* Self-contained: it takes the guest id and loads its own
                    statement, so the same component can be embedded anywhere the
                    whole account is wanted. */}
                <GuestLedger
                  guestId={guestId}
                  tenantId={tenantId}
                  propertyId={propertyId}
                  currency={currency}
                  guestName={guest.full_name}
                  propertyName={propertyName}
                  onOpenStay={openStay}
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <p className="py-10 text-center text-sm text-charcoal-muted" aria-live="polite">
          Loading guest…
        </p>
      )}
    </div>
  );
}
