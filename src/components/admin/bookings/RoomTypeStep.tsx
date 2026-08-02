import { formatCurrency, formatOccupancy, MISSING_VALUE } from '../../../lib/format';
import type { RoomType } from '../../../types/room';

// STEP 2 OF THE NEW-BOOKING PAGE (build B §2) — the room type, as a COLLAPSIBLE
// TABLE rather than a stack of cards.
//
// WHY IT COLLAPSES: the table exists to answer one question — "what is free, and
// what does it hold?" — and once that question is answered the table is nothing
// but noise between the user and the guest fields below. So choosing a type
// collapses the section to a single line (type, occupancy, free, resolved rate)
// with a Change control that brings the table back. The screen therefore gets
// SIMPLER as the booking gets more complete, instead of longer.
//
// A FULLY BOOKED TYPE STAYS VISIBLE, shows its 0, and has no Select control at
// all — not a greyed-out button that invites a click. It is visible because
// "the Family Suite is full" is information the receptionist needs to say out
// loud; it is unselectable because create_booking would reject it anyway
// (the overbooking guard is the real law — this is the courtesy layer).
//
// MOBILE: the table bleeds to the screen edges and scrolls horizontally inside
// its own container (§3) — the page body never scrolls sideways, and no column
// is crushed into nothing. Every Select is a 44px touch target.

interface RoomTypeStepProps {
  roomTypes: RoomType[];
  // Still fetching the room types. Distinguishes "not loaded yet" from "this
  // property has none" — an empty list means nothing until this is false.
  typesLoading: boolean;
  // room type id -> free units for the chosen dates (count_available).
  availability: Map<string, number>;
  availLoading: boolean;
  datesValid: boolean;
  selectedId: string;
  onSelect: (roomTypeId: string) => void;
  // Section open/closed. Transient view state owned by the page — deliberately
  // NOT part of the booking draft, which holds form input only.
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The resolved nightly rate for the CHOSEN type, for the collapsed summary.
  // null when it varies by night or is not resolved yet.
  nightlyRate: number | null;
  rateVaries: boolean;
  rateLoading: boolean;
  negotiated: boolean;
  currency: string;
  disabled: boolean;
}

export function RoomTypeStep({
  roomTypes,
  typesLoading,
  availability,
  availLoading,
  datesValid,
  selectedId,
  onSelect,
  open,
  onOpenChange,
  nightlyRate,
  rateVaries,
  rateLoading,
  negotiated,
  currency,
  disabled,
}: RoomTypeStepProps) {
  const selected = roomTypes.find((rt) => rt.id === selectedId) ?? null;
  const selectedFree = selected ? availability.get(selected.id) : undefined;
  const selectedSoldOut = selectedFree !== undefined && selectedFree <= 0;

  // Collapsed: a chosen type, summarised on one line.
  if (selected && !open) {
    return (
      <div className="rounded-xl border border-sand-border bg-white/70 p-3 sm:p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-sm font-semibold text-charcoal">{selected.name}</p>
            <p className="mt-0.5 text-xs text-charcoal-muted">
              {formatOccupancy(selected.max_adults, selected.max_children)} max
              {' · '}
              {selectedFree === undefined
                ? 'availability unknown'
                : `${selectedFree} free`}
              {' · '}
              {rateLoading
                ? 'pricing…'
                : rateVaries
                  ? 'rate varies by night'
                  : nightlyRate === null
                    ? MISSING_VALUE
                    : `${formatCurrency(nightlyRate, currency)} / night${
                        negotiated ? ' (company rate)' : ''
                      }`}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onOpenChange(true)}
            disabled={disabled}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full border border-sand-border bg-white/70 px-4 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Change
          </button>
        </div>

        {selectedSoldOut ? (
          <p className="mt-2 rounded-lg bg-negative/10 px-3 py-2 text-xs font-medium text-negative">
            This room type has no availability for these dates any more. Choose
            another to continue.
          </p>
        ) : null}
      </div>
    );
  }

  // Expanded: the table.
  if (!datesValid) {
    return (
      <p className="rounded-xl border border-sand-border bg-white/60 px-3 py-4 text-sm text-charcoal-muted">
        Choose valid dates above to see what’s free.
      </p>
    );
  }

  if (roomTypes.length === 0) {
    return (
      <p
        className="rounded-xl border border-sand-border bg-white/60 px-3 py-4 text-sm text-charcoal-muted"
        aria-live="polite"
      >
        {typesLoading
          ? 'Loading room types…'
          : 'This property has no room types to book.'}
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-sand-border bg-white/70">
      {/* The horizontal scroll lives HERE, not on the page: at 360px the table
          keeps its columns and the container scrolls (§3). rounded-xl clips it. */}
      <div className="overflow-x-auto rounded-xl">
        <table className="w-full min-w-[32rem] border-collapse text-left text-sm">
          <caption className="sr-only">
            Room types with occupancy limits and availability for the selected
            dates
          </caption>
          <thead>
            <tr className="border-b border-sand-border bg-sand/40 text-xs uppercase tracking-wide text-charcoal-muted">
              <th scope="col" className="px-3 py-2 font-semibold">
                Room type
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Occupancy
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                Free
              </th>
              <th scope="col" className="px-3 py-2 text-right font-semibold">
                <span className="sr-only">Select</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-sand-border">
            {roomTypes.map((rt) => {
              const free = availability.get(rt.id);
              const soldOut = free !== undefined && free <= 0;
              const isSelected = rt.id === selectedId;
              return (
                <tr
                  key={rt.id}
                  className={isSelected ? 'bg-primary/5' : undefined}
                >
                  <th
                    scope="row"
                    className="px-3 py-2.5 text-sm font-semibold text-charcoal"
                  >
                    {rt.name}
                  </th>
                  <td className="px-3 py-2.5 text-xs text-charcoal-muted">
                    {formatOccupancy(rt.max_adults, rt.max_children)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <span
                      className={`inline-block rounded-full px-2.5 py-1 text-xs font-semibold tabular-nums ${
                        free === undefined
                          ? 'bg-sand text-charcoal-muted'
                          : soldOut
                            ? 'bg-charcoal/10 text-charcoal-muted'
                            : 'bg-accent/15 text-accent'
                      }`}
                    >
                      {free === undefined ? MISSING_VALUE : free}
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    {soldOut ? (
                      // No control at all — a full type cannot be chosen.
                      <span className="text-xs font-medium text-charcoal-muted">
                        Fully booked
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onSelect(rt.id)}
                        disabled={disabled || free === undefined}
                        aria-pressed={isSelected}
                        className={`inline-flex min-h-11 min-w-[5.5rem] items-center justify-center rounded-full px-4 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50 ${
                          isSelected
                            ? 'bg-primary text-white hover:bg-primary-hover focus-visible:ring-primary'
                            : 'border border-sand-border bg-white/80 text-charcoal hover:bg-sand focus-visible:ring-primary'
                        }`}
                      >
                        {isSelected ? 'Selected' : 'Select'}
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {availLoading ? (
        <p
          className="border-t border-sand-border px-3 py-2 text-xs text-charcoal-muted"
          aria-live="polite"
        >
          Checking availability…
        </p>
      ) : null}
    </div>
  );
}
