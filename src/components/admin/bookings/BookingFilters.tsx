import { useState } from 'react';
import { Select } from '../../ui/form';
import type { BookingFilters as Filters } from '../../../lib/bookings';
import { EMPTY_BOOKING_FILTERS } from '../../../lib/bookings';
import { BOOKING_STATUSES, bookingStatusLabel } from '../../../lib/bookingLabels';
import type { Company } from '../../../types/company';
import type { BookingStatus } from '../../../types/booking';

// The bookings filter bar (build 6b §3): status, arrival date range, guest name,
// company. Every filter is applied SERVER-SIDE (rule 1b/20) by the hook; this
// component only collects intent. A local draft is committed on Apply so typing a
// guest name does not refetch on every keystroke.

interface BookingFiltersProps {
  filters: Filters;
  companies: Company[];
  onChange: (filters: Filters) => void;
  disabled?: boolean;
}

export function BookingFilters({
  filters,
  companies,
  onChange,
  disabled,
}: BookingFiltersProps) {
  const [draft, setDraft] = useState<Filters>(filters);

  // Re-seed the draft when filters change from outside (e.g. a Clear elsewhere),
  // via the adjust-state-on-prop-change pattern the form primitives use.
  const [last, setLast] = useState(filters);
  if (filters !== last) {
    setLast(filters);
    setDraft(filters);
  }

  const statusOptions = [
    { value: '', label: 'Any status' },
    ...BOOKING_STATUSES.map((s) => ({ value: s, label: bookingStatusLabel(s) })),
  ];
  const companyOptions = [
    { value: '', label: 'Any (incl. walk-ins)' },
    ...companies.map((c) => ({ value: c.id, label: c.name })),
  ];

  const dirty = JSON.stringify(draft) !== JSON.stringify(filters);
  const anyApplied = JSON.stringify(filters) !== JSON.stringify(EMPTY_BOOKING_FILTERS);

  return (
    <form
      className="rounded-2xl border border-sand-border bg-white/60 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(draft);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Select
          label="Status"
          value={draft.status}
          onChange={(v) => setDraft((d) => ({ ...d, status: v as BookingStatus | '' }))}
          options={statusOptions}
          disabled={disabled}
        />
        <Select
          label="Company"
          value={draft.companyId}
          onChange={(v) => setDraft((d) => ({ ...d, companyId: v }))}
          options={companyOptions}
          disabled={disabled}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-charcoal">Guest name</span>
          <input
            type="text"
            value={draft.guestName}
            onChange={(e) => setDraft((d) => ({ ...d, guestName: e.target.value }))}
            placeholder="Any"
            disabled={disabled}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-charcoal">Arriving from</span>
          <input
            type="date"
            value={draft.arrivalFrom}
            onChange={(e) => setDraft((d) => ({ ...d, arrivalFrom: e.target.value }))}
            disabled={disabled}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-charcoal">Arriving to</span>
          <input
            type="date"
            value={draft.arrivalTo}
            onChange={(e) => setDraft((d) => ({ ...d, arrivalTo: e.target.value }))}
            disabled={disabled}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          />
        </label>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="submit"
          disabled={disabled || !dirty}
          className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-50"
        >
          Apply filters
        </button>
        {anyApplied || dirty ? (
          <button
            type="button"
            onClick={() => onChange(EMPTY_BOOKING_FILTERS)}
            disabled={disabled}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Clear
          </button>
        ) : null}
      </div>
    </form>
  );
}
