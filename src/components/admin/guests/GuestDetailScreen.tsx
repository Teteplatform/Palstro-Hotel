import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError } from '../../../lib/errors';
import { MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { GUEST_ID_TYPE_OPTIONS } from '../../../lib/guests';
import { useGuestHistory } from '../../../hooks/useGuestHistory';
import { GuestHistoryTab } from './GuestHistoryTab';
import { GuestLedger } from './GuestLedger';

// THE GUEST PAGE (2.txt §2, §3) — route /admin/:propertySlug/guests/:guestId.
//
// A ROUTE, NOT A PANEL, for the reasons the booking detail page gives: it can be
// linked to, refreshed into, shared with a manager and — the one that matters
// here — PRINTED. The active tab lives in the URL as ?tab= with replace: true, so
// a refresh returns to the same view and Back goes where the user expects rather
// than through every tab they looked at. No browser storage anywhere.
//
// TWO TABS, TWO QUESTIONS:
//   History — who is this person, how often have they stayed, what have they
//             spent, and how does each stay stand (2.txt §2).
//   Ledger  — one running statement across every stay, bank-statement style,
//             printable (2.txt §3).
//
// THE HEADER IS OUTSIDE BOTH so a printed statement identifies the guest.

const TABS = [
  { id: 'history', label: 'History' },
  { id: 'ledger', label: 'Ledger' },
] as const;

type TabId = (typeof TABS)[number]['id'];

function toTabId(value: string | null): TabId {
  return TABS.some((t) => t.id === value) ? (value as TabId) : 'history';
}

interface GuestDetailScreenProps {
  guestId: string;
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  propertyName: string;
  currency: string;
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
  isAdmin,
}: GuestDetailScreenProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = toTabId(searchParams.get('tab'));
  const navigate = useNavigate();

  const history = useGuestHistory(guestId, tenantId, propertyId);
  const { guest, notFound, error } = history;

  function selectTab(next: TabId) {
    setSearchParams({ tab: next }, { replace: true });
  }

  // A stay opens on its FOLIO tab: from a statement line, what the reader wants
  // next is that stay's itemised bill, not its guest details.
  function openStay(bookingId: string) {
    navigate(`/admin/${propertySlug}/bookings/${bookingId}?tab=folio`);
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

      <header className="mt-4 mb-5">
        <h1 className="text-2xl font-bold tracking-tight text-charcoal">
          {guest?.full_name ?? (notFound ? 'Guest not found' : 'Loading…')}
        </h1>
        {guest ? (
          <dl className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-charcoal-muted">
            <HeaderFact label="Phone" value={guest.phone} />
            <HeaderFact label="Email" value={guest.email} />
            <HeaderFact label="Nationality" value={guest.nationality} />
            <HeaderFact
              label="ID"
              value={
                guest.id_number
                  ? `${idTypeLabel(guest.id_type)} · ${guest.id_number}${
                      guest.id_expiry
                        ? ` · expires ${formatDisplayDate(guest.id_expiry)}`
                        : ''
                    }`
                  : null
              }
            />
          </dl>
        ) : null}
      </header>

      {error ? (
        <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
          <p className="text-sm font-medium text-charcoal">
            We couldn’t load this guest.
          </p>
          {/* Rule 11: the REAL diagnostic. */}
          <p className="mt-1 text-sm text-charcoal-muted">{describeError(error)}</p>
          <button
            type="button"
            onClick={() => void history.reload()}
            className="mt-4 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Try again
          </button>
        </div>
      ) : notFound ? (
        <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
          This guest could not be found in this tenant. They may have been
          removed, or the link may belong to a different hotel.
        </p>
      ) : guest ? (
        <>
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
            {tab === 'history' ? (
              <div
                role="tabpanel"
                id="guest-panel-history"
                aria-labelledby="guest-tab-history"
              >
                <GuestHistoryTab
                  guest={guest}
                  tenantId={tenantId}
                  summary={history.summary}
                  summaryLoading={history.summaryLoading}
                  stays={history.stays}
                  count={history.count}
                  page={history.page}
                  pageSize={history.pageSize}
                  loading={history.loading}
                  currency={currency}
                  canEdit={isAdmin}
                  onPageChange={history.setPage}
                  onPageSizeChange={history.setPageSize}
                  onOpenStay={openStay}
                  onGuestChanged={history.reload}
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
                    statement, so the same component can later be embedded
                    anywhere the whole account is wanted. */}
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

// One header fact, hidden entirely when there is nothing to say — a row of
// dashes above a guest's name reads as a broken record rather than a sparse one.
function HeaderFact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-xs uppercase tracking-wide">{label}</dt>
      <dd className="text-charcoal">{value}</dd>
    </div>
  );
}

// The stored id_type is a machine value ('national_id'); staff read the label.
// An unrecognised value is shown as-is — data the app does not recognise still
// belongs to the hotel.
function idTypeLabel(value: string | null): string {
  if (!value) return MISSING_VALUE;
  return GUEST_ID_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
