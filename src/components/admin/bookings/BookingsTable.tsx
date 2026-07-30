import { useEffect, useState } from 'react';
import { formatCurrency, formatOccupancy, MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate, nightsBetween } from '../../../lib/date';
import { bookingTotal } from '../../../lib/bookings';
import {
  BOOKING_STATUSES,
  bookingStatusLabel,
  bookingStatusTone,
} from '../../../lib/bookingLabels';
import type { BookingFilters } from '../../../lib/bookings';
import { EMPTY_BOOKING_FILTERS } from '../../../lib/bookings';
import type { BookingListRow, BookingStatus } from '../../../types/booking';
import type { Company } from '../../../types/company';
import type { RoomType } from '../../../types/room';

// The bookings DATA TABLE (brief 1.txt §2). Replaces the card list + standalone
// filter panel with a dense, front-desk-scannable table whose COLUMN HEADERS carry
// the filtering inline:
//   - text search in the Booking-number and Guest headers (debounced so typing
//     does not refetch per keystroke),
//   - a select in the Status, Room type and Company headers (commit immediately).
// The one filter that does not fit a header — the arrival DATE RANGE — lives in a
// small collapsible control above the table, COLLAPSED by default (brief).
//
// Every filter is applied SERVER-SIDE by the hook (rules 1b/20); this component
// only collects intent and calls onFiltersChange. Pagination, the filtered totals
// and the summary all stay in BookingsScreen — this is presentation only and must
// not weaken any of them (the table never caps or slices).
//
// RESPONSIVE DECISION (brief asks to pick one and say which): HORIZONTAL SCROLL
// with the Booking-number column PINNED (sticky-left). Rationale — the header
// filters ARE the table head, so a single table keeps ONE filter implementation
// (a divergent stacked layout would need a second filter UI and a second place to
// fix the next bug). A min-width keeps every column its natural shape; on a 360px
// screen the table scrolls horizontally while the booking number — the row's
// identity anchor — stays fixed on the left, so you never lose which reservation a
// row is. Numeric columns (Nights, Total) are right-aligned as a real table would.

interface BookingsTableProps {
  rows: BookingListRow[];
  filters: BookingFilters;
  onFiltersChange: (filters: BookingFilters) => void;
  companies: Company[];
  roomTypes: RoomType[];
  currency: string;
  loading: boolean;
  onOpenRow: (id: string) => void;
}

// Debounce for the two free-text header filters, so refetch fires once the user
// pauses rather than on every keystroke.
const TEXT_FILTER_DEBOUNCE_MS = 350;

export function BookingsTable({
  rows,
  filters,
  onFiltersChange,
  companies,
  roomTypes,
  currency,
  loading,
  onOpenRow,
}: BookingsTableProps) {
  // Local mirrors of the two TEXT filters so the inputs stay responsive and keep
  // focus across list reloads (this component stays mounted; only `rows` changes).
  const [numberInput, setNumberInput] = useState(filters.bookingNumber);
  const [guestInput, setGuestInput] = useState(filters.guestName);

  // The text values we last COMMITTED ourselves. Every commit changes the `filters`
  // identity, which fires the reseed below; without this we would overwrite the
  // local inputs with the just-committed (older) value and drop any character typed
  // during the refetch window. So the reseed adopts a committed field ONLY when it
  // differs from what we committed — i.e. an EXTERNAL change (Clear all filters),
  // never our own echo. Held in state (not a ref) so it is readable during render;
  // this is the adjust-state-on-prop-change pattern, applied per text field.
  const [committed, setCommitted] = useState({
    bookingNumber: filters.bookingNumber,
    guestName: filters.guestName,
  });
  const [seed, setSeed] = useState(filters);
  if (filters !== seed) {
    setSeed(filters);
    let next = committed;
    if (filters.bookingNumber !== committed.bookingNumber) {
      setNumberInput(filters.bookingNumber);
      next = { ...next, bookingNumber: filters.bookingNumber };
    }
    if (filters.guestName !== committed.guestName) {
      setGuestInput(filters.guestName);
      next = { ...next, guestName: filters.guestName };
    }
    if (next !== committed) setCommitted(next);
  }

  // Commit the debounced text filters once the user pauses. The equality guard
  // stops an unchanged commit; recording `committed` alongside onFiltersChange means
  // the reseed triggered by the resulting filters change sees "our own echo" and
  // leaves the (possibly newer) local input untouched.
  useEffect(() => {
    const t = setTimeout(() => {
      if (
        numberInput !== filters.bookingNumber ||
        guestInput !== filters.guestName
      ) {
        setCommitted({ bookingNumber: numberInput, guestName: guestInput });
        onFiltersChange({
          ...filters,
          bookingNumber: numberInput,
          guestName: guestInput,
        });
      }
    }, TEXT_FILTER_DEBOUNCE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [numberInput, guestInput]);

  // Selects commit immediately — a single click, no debounce needed.
  const commit = (patch: Partial<BookingFilters>) =>
    onFiltersChange({ ...filters, ...patch });

  const dateRangeApplied = !!(filters.arrivalFrom || filters.arrivalTo);
  const anyApplied =
    JSON.stringify(filters) !== JSON.stringify(EMPTY_BOOKING_FILTERS);

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <DateRangeControl
          from={filters.arrivalFrom}
          to={filters.arrivalTo}
          applied={dateRangeApplied}
          disabled={loading}
          onChange={(from, to) =>
            commit({ arrivalFrom: from, arrivalTo: to })
          }
        />
        {anyApplied ? (
          <button
            type="button"
            onClick={() => onFiltersChange(EMPTY_BOOKING_FILTERS)}
            disabled={loading}
            className="rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Clear all filters
          </button>
        ) : null}
      </div>

      <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
        <table className="w-full min-w-[960px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-left align-top">
              {/* Booking number — pinned (sticky-left) identity anchor, text filter. */}
              <Th sticky className="min-w-[9.5rem]">
                <HeaderLabel>No.</HeaderLabel>
                <HeaderText
                  value={numberInput}
                  onChange={setNumberInput}
                  placeholder="Search no."
                  ariaLabel="Filter by booking number"
                  disabled={loading}
                />
              </Th>
              {/* Guest — text filter. */}
              <Th className="min-w-[11rem]">
                <HeaderLabel>Guest</HeaderLabel>
                <HeaderText
                  value={guestInput}
                  onChange={setGuestInput}
                  placeholder="Search guest"
                  ariaLabel="Filter by guest name"
                  disabled={loading}
                />
              </Th>
              {/* Room type — select filter. */}
              <Th className="min-w-[10rem]">
                <HeaderLabel>Room type</HeaderLabel>
                <HeaderSelect
                  value={filters.roomTypeId}
                  onChange={(v) => commit({ roomTypeId: v })}
                  ariaLabel="Filter by room type"
                  disabled={loading}
                  options={[
                    { value: '', label: 'Any room type' },
                    ...roomTypes.map((rt) => ({ value: rt.id, label: rt.name })),
                  ]}
                />
              </Th>
              {/* Check-in / Check-out / Nights — no header filter. */}
              <Th className="min-w-[6.5rem]">
                <HeaderLabel>Check-in</HeaderLabel>
              </Th>
              <Th className="min-w-[6.5rem]">
                <HeaderLabel>Check-out</HeaderLabel>
              </Th>
              <Th align="right" className="min-w-[4.5rem]">
                <HeaderLabel>Nights</HeaderLabel>
              </Th>
              {/* Status — select filter. */}
              <Th className="min-w-[8.5rem]">
                <HeaderLabel>Status</HeaderLabel>
                <HeaderSelect
                  value={filters.status}
                  onChange={(v) => commit({ status: v as BookingStatus | '' })}
                  ariaLabel="Filter by status"
                  disabled={loading}
                  options={[
                    { value: '', label: 'Any status' },
                    ...BOOKING_STATUSES.map((s) => ({
                      value: s,
                      label: bookingStatusLabel(s),
                    })),
                  ]}
                />
              </Th>
              {/* Company / Walk-in — select filter. */}
              <Th className="min-w-[10rem]">
                <HeaderLabel>Company / Walk-in</HeaderLabel>
                <HeaderSelect
                  value={filters.companyId}
                  onChange={(v) => commit({ companyId: v })}
                  ariaLabel="Filter by company"
                  disabled={loading}
                  options={[
                    { value: '', label: 'Any (incl. walk-ins)' },
                    ...companies.map((c) => ({ value: c.id, label: c.name })),
                  ]}
                />
              </Th>
              {/* Total — right-aligned, no header filter. */}
              <Th align="right" className="min-w-[7rem]">
                <HeaderLabel>Total</HeaderLabel>
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={9} className="px-4 py-12 text-center">
                  {loading ? (
                    <span
                      className="inline-flex items-center gap-2 text-sm text-charcoal-muted"
                      aria-busy="true"
                      aria-live="polite"
                    >
                      <span className="h-4 w-4 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
                      Loading bookings…
                    </span>
                  ) : (
                    <span className="text-sm text-charcoal-muted">
                      {anyApplied
                        ? 'No bookings match these filters. Adjust or clear them above.'
                        : 'No bookings yet. Create one to get started.'}
                    </span>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <BookingTableRow
                  key={row.id}
                  row={row}
                  currency={currency}
                  onOpen={() => onOpenRow(row.id)}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function BookingTableRow({
  row,
  currency,
  onOpen,
}: {
  row: BookingListRow;
  currency: string;
  onOpen: () => void;
}) {
  const nights = nightsBetween(row.check_in, row.check_out);
  const total = bookingTotal(row.booking_nights);

  return (
    <tr
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      className="group cursor-pointer border-b border-sand-border/70 transition-colors last:border-b-0 hover:bg-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
    >
      {/* Booking number — pinned identity anchor, tabular for alignment. */}
      <td className="sticky left-0 z-10 whitespace-nowrap bg-white px-4 py-3 font-medium tabular-nums text-charcoal transition-colors group-hover:bg-sand/40">
        {row.booking_number}
      </td>
      <td className="px-4 py-3">
        <span className="block truncate font-semibold text-charcoal">
          {row.guest?.full_name ?? MISSING_VALUE}
        </span>
        <span className="block text-xs text-charcoal-muted">
          {formatOccupancy(row.adults, row.children)}
        </span>
      </td>
      <td className="px-4 py-3 text-charcoal">
        {row.room_type?.name ?? MISSING_VALUE}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-charcoal">
        {formatDisplayDate(row.check_in)}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-charcoal">
        {formatDisplayDate(row.check_out)}
      </td>
      <td className="px-4 py-3 text-right tabular-nums text-charcoal">
        {nights}
      </td>
      <td className="px-4 py-3">
        <span
          className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${bookingStatusTone(row.status)}`}
        >
          {bookingStatusLabel(row.status)}
        </span>
      </td>
      <td className="px-4 py-3">
        {row.company ? (
          <span className="text-charcoal">{row.company.name}</span>
        ) : (
          <span className="text-charcoal-muted">Walk-in</span>
        )}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right font-bold tabular-nums text-charcoal">
        {formatCurrency(total, currency)}
      </td>
    </tr>
  );
}

// A small collapsible arrival-date-range control, collapsed by default (brief).
function DateRangeControl({
  from,
  to,
  applied,
  disabled,
  onChange,
}: {
  from: string;
  to: string;
  applied: boolean;
  disabled?: boolean;
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        Arrival date range
        {applied ? (
          <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">
            on
          </span>
        ) : null}
        <span aria-hidden="true" className="text-charcoal-muted">
          {open ? '▲' : '▼'}
        </span>
      </button>

      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-72 rounded-xl border border-sand-border bg-cream p-4 shadow-lg">
          <div className="grid grid-cols-1 gap-3">
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-charcoal">
                Arriving from
              </span>
              <input
                type="date"
                value={from}
                disabled={disabled}
                onChange={(e) => onChange(e.target.value, to)}
                className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-xs font-medium text-charcoal">
                Arriving to
              </span>
              <input
                type="date"
                value={to}
                min={from || undefined}
                disabled={disabled}
                onChange={(e) => onChange(from, e.target.value)}
                className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
              />
            </label>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => onChange('', '')}
              disabled={disabled || !applied}
              className="text-xs font-semibold text-charcoal-muted underline-offset-2 hover:underline disabled:opacity-40"
            >
              Clear range
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-full bg-primary px-4 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Done
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// --- Header cell primitives -------------------------------------------------

function Th({
  children,
  align = 'left',
  sticky = false,
  className = '',
}: {
  children: React.ReactNode;
  align?: 'left' | 'right';
  sticky?: boolean;
  className?: string;
}) {
  return (
    <th
      scope="col"
      className={`px-4 py-2.5 font-semibold ${align === 'right' ? 'text-right' : 'text-left'} ${
        sticky ? 'sticky left-0 z-20 bg-sand/40' : ''
      } ${className}`}
    >
      {children}
    </th>
  );
}

function HeaderLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="block text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
      {children}
    </span>
  );
}

function HeaderText({
  value,
  onChange,
  placeholder,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      aria-label={ariaLabel}
      disabled={disabled}
      className="mt-1.5 w-full rounded-lg border border-sand-border bg-white/80 px-2 py-1 text-xs font-normal text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
    />
  );
}

function HeaderSelect({
  value,
  onChange,
  options,
  ariaLabel,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
      className="mt-1.5 w-full rounded-lg border border-sand-border bg-white/80 px-2 py-1 text-xs font-normal text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
