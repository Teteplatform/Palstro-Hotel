import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Pagination } from '../../ui/Pagination';
import { AboutNote } from '../../ui/AboutNote';
import { CalculationNote } from '../../ui/CalculationNote';
import { ActionMenu } from '../../ui/ActionMenu';
import type { ActionMenuItem } from '../../ui/ActionMenu';
import { DateField, Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { useOpenStockTake, useStockTakes } from '../../../hooks/useStockTakes';
import { formatDisplayDate, todayIsoInZone } from '../../../lib/date';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import {
  newIdempotencyKey,
  startStockTake,
  stockErrorMessage,
} from '../../../lib/stockTake';
import {
  COUNT_PROGRESS_EXPLANATION,
  COUNT_VARIANCE_EXPLANATION,
  STOCK_TAKE_ABOUT,
  STOCK_TAKE_ABOUT_TITLE,
  takeStatusLabel,
  takeStatusTone,
} from '../../../lib/stockTakeLabels';
import type { StockLocation } from '../../../types/inventory';
import type { StockTakeProgressRow } from '../../../types/stockTake';

// THE STOCK TAKE TAB — a LAUNCHER and a list, and nothing else.
//
// ---------------------------------------------------------------------------
// WHAT MOVED OFF THIS TAB, AND WHY
// ---------------------------------------------------------------------------
// The count sheet itself used to render here, inside the inventory module's tab
// strip, under the page header and the location picker. With a real sheet on
// screen that was plainly wrong: somebody counting a store is doing ONE job for
// the next two hours, and a tab row above the sheet is an invitation to lose it
// by clicking something. It has its own page now
// (/inventory/counts/:takeId) — deep-linkable, refreshable, printable.
//
// What is left here is what a tab is good at: starting the job, and listing the
// jobs already done so any of them can be opened.
//
// ---------------------------------------------------------------------------
// AND WHAT MOVED BEHIND THE ⓘ (rule 25)
// ---------------------------------------------------------------------------
// Before you could do anything here you read: a paragraph about snapshots, a
// paragraph about saving as you go, a paragraph about one count per location,
// three field hints, and a paragraph under the Start button about counts versus
// write-offs. The screen was teaching when the person had come to work.
//
// All of it is intact — in ONE ⓘ beside the heading, and in the staff guide
// under "Counting a location", which the panel links to. What is left on screen
// is one line of purpose and the three fields, so the first thing you see is
// the thing you came to press.
//
// ---------------------------------------------------------------------------
// THE KEBAB, AND THE ONE ACTION IT WILL NEVER OFFER
// ---------------------------------------------------------------------------
// Each row's actions depend on the document's state, and there is no DELETE on
// any of them. A finished count moved real stock and a manager approved it;
// removing the record would remove the evidence that both happened. So:
//   in progress -> Carry on counting, Print the blank sheet
//   finished    -> Open the report, Print, Undo the count (manager PIN)
//   abandoned   -> Open (what was counted before it was given up)
//   reversed    -> Open (what it found, and that it was undone)

interface StockTakeTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  locations: StockLocation[];
  locationId: string | null;
  onPosted: () => Promise<void> | void;
}

export function StockTakeTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  locations,
  locationId,
  onPosted,
}: StockTakeTabProps) {
  const toast = useToast();
  const navigate = useNavigate();
  const today = todayIsoInZone(timezone);

  // A count is always of ONE location's shelves (039 §2): stock is physical, and
  // a count "across the property" would be several counts pretending to be one.
  // The page's location selector seeds this; "All locations" falls back to the
  // first, and the field says which.
  const [countLocationId, setCountLocationId] = useState(
    locationId ?? locations[0]?.id ?? '',
  );
  const [countDate, setCountDate] = useState(today);
  const [note, setNote] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const open = useOpenStockTake(tenantId, propertyId, countLocationId || null);
  const history = useStockTakes(tenantId, propertyId);

  const location = locations.find((l) => l.id === countLocationId) ?? null;

  const locationOptions: SelectOption[] = locations.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  const countUrl = (id: string) => `/admin/${propertySlug}/inventory/counts/${id}`;
  const printUrl = (id: string) => `${countUrl(id)}/print`;

  async function handleStart() {
    if (!location) return;
    setStarting(true);
    setStartError(null);
    try {
      const take = await startStockTake({
        propertyId,
        locationId: location.id,
        businessDate: countDate || null,
        note: note.trim() ? note.trim() : null,
        // Rules 2/3: one key per Start press, so a double-click returns the
        // count that was started rather than colliding with the one-open-count
        // rule and showing an error for something that in fact worked.
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`Count ${take.take_number} started.`);
      setNote('');
      await onPosted();
      // Straight onto the sheet. Starting a count is not a thing anybody does
      // for its own sake — the next act is always counting.
      navigate(countUrl(take.id));
    } catch (e) {
      // Rule 21: the server's own sentence, with its hint. This screen has no
      // opinion about why a count could not start.
      setStartError(stockErrorMessage(e));
    } finally {
      setStarting(false);
    }
  }

  function menuFor(row: StockTakeProgressRow): ActionMenuItem[] {
    const items: ActionMenuItem[] = [];

    if (row.status === 'open') {
      items.push({
        key: 'open',
        label: 'Carry on counting',
        hint: 'Opens the sheet where it was left.',
        onSelect: () => navigate(countUrl(row.stock_take_id)),
      });
      items.push({
        key: 'print',
        label: 'Print the count sheet',
        hint: 'The blank sheet to carry round the store. No expected figures on it.',
        onSelect: () => window.open(printUrl(row.stock_take_id), '_blank', 'noreferrer'),
      });
      return items;
    }

    items.push({
      key: 'open',
      label: row.status === 'cancelled' ? 'Open this count' : 'Open the report',
      hint:
        row.status === 'cancelled'
          ? 'What was counted before it was abandoned.'
          : 'Expected, counted, difference and value, line by line.',
      onSelect: () => navigate(countUrl(row.stock_take_id)),
    });
    items.push({
      key: 'print',
      label: 'Print or save as PDF',
      hint: 'Opens the report on its own page, ready to print, sign and file.',
      onSelect: () => window.open(printUrl(row.stock_take_id), '_blank', 'noreferrer'),
    });
    if (row.status === 'finished') {
      items.push({
        key: 'reverse',
        label: 'Undo this count',
        hint: 'Puts every shelf back. Needs a manager’s PIN and a reason.',
        tone: 'danger',
        // The form lives on the count's own page, beside the figures being
        // undone — a PIN box on a list row would ask somebody to approve a
        // reversal of numbers they cannot see.
        onSelect: () => navigate(countUrl(row.stock_take_id)),
      });
    }
    return items;
  }

  if (locations.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
        This hotel has no stock locations yet. Add one under “Manage locations”
        before counting anything.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {/* ------------------------------------------------------------- */}
      {/* Starting one                                                  */}
      {/* ------------------------------------------------------------- */}
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold text-charcoal">
            Count a location’s shelves and post what you find.
          </h2>
          <AboutNote
            title={STOCK_TAKE_ABOUT_TITLE}
            paragraphs={STOCK_TAKE_ABOUT}
            propertySlug={propertySlug}
            guideAnchor="counting-a-location"
            guideLabel="Counting a location"
          />
        </div>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Location"
            required
            value={countLocationId}
            onChange={(v) => {
              setCountLocationId(v);
              setStartError(null);
            }}
            options={locationOptions}
            disabled={starting || open.loading}
          />
          <DateField
            label="Count date"
            required
            value={countDate}
            onChange={setCountDate}
            max={today}
            disabled={starting}
            helpText="The day you walked the shelves — not today, if they differ."
          />
          {/* The two hints that survived. "Count date" genuinely cannot carry
              "the day you walked the shelves, which may not be today", and
              "Note" cannot carry "this is stamped permanently onto every
              movement the count posts" — both change what a person types. The
              Location hint above said "A count covers one location's shelves",
              which the label already said. */}
          <TextField
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="e.g. Counted with the chef"
            disabled={starting}
            helpText="Recorded on every movement the count posts."
          />
        </div>

        {startError ? (
          <p className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm text-charcoal">
            {startError}
          </p>
        ) : null}

        {/* A count already running in the chosen location: the way in is the
            sheet itself, not a second Start button that would only ever be
            refused. */}
        {open.take ? (
          <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-accent/40 bg-accent/10 p-3">
            <p className="text-sm text-charcoal">
              <span className="font-semibold">{open.take.take_number}</span> is
              already in progress here — {open.take.counted_count} counted,{' '}
              {open.take.uncounted_count} to go.
            </p>
            <button
              type="button"
              onClick={() => navigate(countUrl(open.take!.stock_take_id))}
              className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Carry on counting
            </button>
          </div>
        ) : (
          // No paragraph under the button (rule 25): the note about counts
          // versus write-offs is in the ⓘ above, where somebody can choose to
          // read it, and the label says what pressing it does.
          <div className="mt-3">
            <button
              type="button"
              onClick={() => void handleStart()}
              disabled={starting || open.loading || !location}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {starting
                ? 'Starting…'
                : `Start counting ${location?.name ?? ''}`.trim()}
            </button>
          </div>
        )}
      </div>

      {/* ------------------------------------------------------------- */}
      {/* Counts already run                                            */}
      {/* ------------------------------------------------------------- */}
      <div className="rounded-2xl border border-sand-border bg-white/60">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-sand-border px-4 py-3">
          <h3 className="text-sm font-semibold text-charcoal">Counts on file</h3>
          <div className="w-full sm:w-56">
            <Select
              label="Location"
              value={history.filters.locationId}
              onChange={(v) =>
                history.setFilters({ ...history.filters, locationId: v })
              }
              options={[{ value: '', label: 'Every location' }, ...locationOptions]}
              disabled={history.loading}
            />
          </div>
        </div>

        {history.error ? (
          <p className="px-4 py-6 text-center text-sm text-charcoal">
            We couldn’t load the counts: {history.error.message}
          </p>
        ) : history.loading && history.rows.length === 0 ? (
          <div className="flex items-center justify-center py-12" aria-busy="true">
            <span className="sr-only">Loading counts…</span>
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
          </div>
        ) : history.rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-charcoal-muted">
            No counts yet. The first one starts above.
          </p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-sm sm:min-w-[40rem]">
                <thead>
                  <tr className="border-b border-sand-border bg-sand/40 text-left">
                    <th scope="col" className="px-4 py-2 text-xs font-semibold text-charcoal-muted">
                      Count
                    </th>
                    <th scope="col" className="px-2 py-2 text-xs font-semibold text-charcoal-muted">
                      Status
                    </th>
                    <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                      <span className="inline-flex items-center gap-1.5">
                        Counted
                        <CalculationNote note={COUNT_PROGRESS_EXPLANATION} />
                      </span>
                    </th>
                    <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                      <span className="inline-flex items-center gap-1.5">
                        Change in value
                        <CalculationNote note={COUNT_VARIANCE_EXPLANATION} />
                      </span>
                    </th>
                    <th scope="col" className="px-4 py-2 text-right text-xs font-semibold text-charcoal-muted">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-sand-border/50">
                  {history.rows.map((row) => (
                    <tr key={row.stock_take_id}>
                      <td className="px-4 py-2.5 align-top">
                        {/* The row's primary action is a real control, not a
                            menu item: the menu is for the rest. */}
                        <button
                          type="button"
                          onClick={() => navigate(countUrl(row.stock_take_id))}
                          className="block text-left font-medium text-charcoal underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
                        >
                          {row.take_number}
                        </button>
                        <span className="mt-0.5 block text-xs text-charcoal-muted">
                          {row.location_name} ·{' '}
                          {/* Rule 8/12: the operating day, never created_at. */}
                          {formatDisplayDate(row.business_date)}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 align-top">
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${takeStatusTone(
                            row.status,
                          )}`}
                        >
                          {takeStatusLabel(row.status)}
                        </span>
                      </td>
                      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted">
                        {row.counted_count} of {row.line_count}
                      </td>
                      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal">
                        {/* NULL while a count is open or abandoned — the figure
                            is blind, not zero (039 §4), so it shows the shared
                            dash rather than a confident nothing. */}
                        {row.net_variance_value === null
                          ? MISSING_VALUE
                          : formatMoney(row.net_variance_value, currency)}
                      </td>
                      <td className="px-4 py-2.5 text-right align-top">
                        <ActionMenu
                          label={`Actions for count ${row.take_number}`}
                          items={menuFor(row)}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="px-4 pb-4">
              <Pagination
                page={history.page}
                pageSize={history.pageSize}
                totalCount={history.count}
                onPageChange={history.setPage}
                onPageSizeChange={history.setPageSize}
                disabled={history.loading}
                itemNoun="counts"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
