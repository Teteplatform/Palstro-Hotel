import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { DateField, Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { useStockOnHand } from '../../../hooks/useStockOnHand';
import { todayIsoInZone } from '../../../lib/date';
import { formatMoney, formatQuantity, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import {
  newIdempotencyKey,
  postStockAdjustment,
  stockErrorMessage,
} from '../../../lib/stock';
import { STOCK_COUNT_POSTING_NOTE } from '../../../lib/stockLabels';
import type { InventoryCategory, StockLocation } from '../../../types/inventory';

// STOCK TAKE — walk the store, key what is actually there, and post the
// differences.
//
// WHAT THIS POSTS, AND WHY IT IS NOT A "COUNT" MOVEMENT. 036 declares a
// 'count_adjustment' movement type and deliberately gives it NO WRITE PATH:
// stock_movements has no write policy for anyone, and the only two RPCs that
// insert into it hardcode 'opening' and 'adjustment'. That is structural, not an
// oversight — the count tranche owns that type, along with the count SHEET (a
// counted-vs-expected document that survives a half-finished count, is signed
// off, and can be re-opened).
//
// So this posts each difference through post_stock_adjustment, as an ADJUSTMENT
// carrying the count and its date as the reason. It is the honest version of the
// job with today's engine: every line is permanent, reasoned and attributed, and
// nothing here pretends to be a movement type it cannot write. The tab says so
// too — see STOCK_COUNT_POSTING_NOTE.
//
// THE COUNT SHEET SPANS PAGES. What you key is held per item, so paging through
// a long store keeps every number you have already entered — and posting sends
// all of them, not the page. Each line carries its OWN idempotency key from the
// moment it is first keyed, so a retry after a partial failure re-sends the same
// intent and can never post a line twice (rules 2/3).
//
// NOTHING IS PRE-FILLED (rule 10's principle, applied to a count). A counted
// quantity seeded from what the system already believes is not a count — it is
// the system agreeing with itself, which is exactly the check a stock take
// exists to break.

interface StockTakeTabProps {
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  locations: StockLocation[];
  categories: InventoryCategory[];
  locationId: string | null;
  onPosted: () => Promise<void> | void;
}

interface CountLine {
  // What was keyed, kept as the raw string so a half-typed "1." is not thrown
  // away mid-keystroke.
  counted: string;
  // The row as it was when the line was keyed, so a line can be posted from a
  // page it is no longer on.
  itemName: string;
  baseUnit: string;
  onHand: string;
  // Rules 2/3: one key per line, generated once, reused on every retry.
  idempotencyKey: string;
}

export function StockTakeTab({
  tenantId,
  propertyId,
  currency,
  timezone,
  locations,
  categories,
  locationId,
  onPosted,
}: StockTakeTabProps) {
  const toast = useToast();
  const today = todayIsoInZone(timezone);

  const [countLocationId, setCountLocationId] = useState(
    locationId ?? locations[0]?.id ?? '',
  );
  const [countDate, setCountDate] = useState(today);
  const [note, setNote] = useState('');
  const [lines, setLines] = useState<Map<string, CountLine>>(new Map());
  const [posting, setPosting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [failures, setFailures] = useState<{ name: string; message: string }[]>([]);

  const list = useStockOnHand(tenantId, propertyId, countLocationId || null);
  const location = locations.find((l) => l.id === countLocationId) ?? null;

  const locationOptions: SelectOption[] = locations.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  function setCounted(
    itemId: string,
    counted: string,
    snapshot: Omit<CountLine, 'counted' | 'idempotencyKey'>,
  ) {
    setLines((prev) => {
      const next = new Map(prev);
      if (counted.trim() === '') {
        next.delete(itemId);
        return next;
      }
      const existing = next.get(itemId);
      next.set(itemId, {
        ...snapshot,
        counted,
        // Generated ONCE per line and kept: a retry must re-send the same intent.
        idempotencyKey: existing?.idempotencyKey ?? newIdempotencyKey(),
      });
      return next;
    });
  }

  // A line only produces a movement when the count DIFFERS from what the system
  // believes. Counting a shelf and finding it right is a real and common
  // outcome, and posting a zero-quantity movement for it would be refused by the
  // database anyway (a movement of nothing is not a movement, 036 §1).
  const variances = Array.from(lines.entries())
    .map(([itemId, line]) => {
      const counted = parseNumeric(line.counted);
      const onHand = parseNumeric(line.onHand) ?? 0;
      if (counted === null) return null;
      const difference = counted - onHand;
      return { itemId, line, counted, onHand, difference };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null && v.difference !== 0);

  async function handlePost() {
    if (!location || variances.length === 0) return;
    setPosting(true);
    setFailures([]);
    setProgress({ done: 0, total: variances.length });

    const failed: { name: string; message: string }[] = [];
    const posted = new Set<string>();

    // One at a time rather than in parallel: these are ledger writes against the
    // same location, the count is small, and a serial loop means a failure
    // halfway leaves a state that is obvious rather than interleaved.
    for (const variance of variances) {
      try {
        await postStockAdjustment({
          propertyId,
          locationId: location.id,
          inventoryItemId: variance.itemId,
          // SIGNED: counted minus what the system believed.
          quantity: variance.difference,
          reason: note.trim()
            ? `Stock count on ${countDate} — ${note.trim()}`
            : `Stock count on ${countDate}`,
          businessDate: countDate || null,
          // A count states no new cost. Found stock is the same stock at the
          // same cost, so the current average is the right default and 036
          // applies it; a removal may state no cost at all.
          unitCost: null,
          idempotencyKey: variance.line.idempotencyKey,
          // A count cannot drive stock below zero — the counted quantity IS the
          // result, and it is never negative — so nothing needs confirming.
          allowNegative: false,
        });
        posted.add(variance.itemId);
      } catch (e) {
        // 036 raises sentences a storekeeper can act on; shown verbatim.
        failed.push({
          name: variance.line.itemName,
          message: stockErrorMessage(e),
        });
      } finally {
        setProgress((p) => ({ ...p, done: p.done + 1 }));
      }
    }

    // Clear only what actually posted, so a retry re-sends exactly the lines
    // that did not — with their original keys.
    setLines((prev) => {
      const next = new Map(prev);
      for (const id of posted) next.delete(id);
      // A line that matched the system was never a variance; clear those too, so
      // the sheet empties as the count is finished.
      for (const [id, line] of prev) {
        const counted = parseNumeric(line.counted);
        const onHand = parseNumeric(line.onHand) ?? 0;
        if (counted !== null && counted - onHand === 0) next.delete(id);
      }
      return next;
    });

    setFailures(failed);
    setPosting(false);

    if (posted.size > 0) {
      toast.success(
        `${posted.size} ${posted.size === 1 ? 'difference' : 'differences'} recorded.`,
      );
      await list.reload();
      await onPosted();
    }
    if (failed.length > 0) {
      toast.error(
        `${failed.length} ${failed.length === 1 ? 'line' : 'lines'} could not be recorded.`,
      );
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <h2 className="text-base font-semibold text-charcoal">Stock take</h2>
        <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
          Key what is actually on the shelf beside what the system believes. Only
          the differences are recorded, and only when you post them.{' '}
          {STOCK_COUNT_POSTING_NOTE}
        </p>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Select
            label="Location"
            required
            value={countLocationId}
            onChange={(v) => {
              setCountLocationId(v);
              // A count sheet belongs to one location — carrying keyed numbers
              // across would post them against the wrong shelf.
              setLines(new Map());
              setFailures([]);
            }}
            options={locationOptions}
            disabled={posting}
          />
          <DateField
            label="Count date"
            required
            value={countDate}
            onChange={setCountDate}
            max={today}
            disabled={posting}
            helpText="The day you counted — not today, if they differ."
          />
          <TextField
            label="Note"
            value={note}
            onChange={setNote}
            placeholder="e.g. Counted with the chef"
            disabled={posting}
            helpText="Added to the reason recorded against every line."
          />
        </div>
      </div>

      {locations.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
          This hotel has no stock locations yet. Add one under “Manage locations”
          before counting anything.
        </p>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Category"
              value={list.filters.categoryId}
              onChange={(v) => list.setFilters({ ...list.filters, categoryId: v })}
              options={categoryOptions}
              disabled={posting}
            />
            <Select
              label="Show"
              value={list.filters.state}
              onChange={(v) =>
                list.setFilters({
                  ...list.filters,
                  state: v as typeof list.filters.state,
                })
              }
              options={[
                { value: '', label: 'Everything with movements here' },
                { value: 'in_stock', label: 'Holding stock' },
                { value: 'low', label: 'At or below reorder level' },
                { value: 'zero', label: 'Nothing on hand' },
                { value: 'negative', label: 'Less than nothing' },
              ]}
              disabled={posting}
            />
          </div>

          {list.error ? (
            <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
              We couldn’t load this location’s stock: {list.error.message}
            </p>
          ) : list.loading && list.rows.length === 0 ? (
            <div
              className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
              aria-busy="true"
              aria-live="polite"
            >
              <span className="sr-only">Loading stock…</span>
              <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
            </div>
          ) : list.rows.length === 0 ? (
            <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
              Nothing has ever moved in {location?.name ?? 'this location'}, so
              there is nothing to count. Record opening balances first — an item
              with no history here has no cost to value a count against.
            </p>
          ) : (
            <>
              <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
                <table className="w-full border-collapse text-sm sm:min-w-[42rem]">
                  <thead>
                    <tr className="border-b border-sand-border bg-sand/40 text-left">
                      <th scope="col" className="px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4">
                        Item
                      </th>
                      <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                        System says
                      </th>
                      <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                        Counted
                      </th>
                      <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                        Difference
                      </th>
                      <th scope="col" className="hidden px-2 py-2 text-right text-xs font-semibold text-charcoal-muted lg:table-cell">
                        Value of difference
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-sand-border/50">
                    {list.rows.map((row) => {
                      const line = lines.get(row.inventory_item_id) ?? null;
                      const counted = line ? parseNumeric(line.counted) : null;
                      const onHand = parseNumeric(row.quantity_on_hand) ?? 0;
                      const difference = counted === null ? null : counted - onHand;
                      const cost = parseNumeric(row.moving_average_cost) ?? 0;

                      return (
                        <tr key={row.inventory_item_id}>
                          <td className="px-3 py-2.5 align-top sm:px-4">
                            <span className="block font-medium text-charcoal">
                              {row.item_name}
                            </span>
                            <span className="mt-0.5 block text-xs text-charcoal-muted">
                              {row.item_code ? `${row.item_code} · ` : ''}
                              in {row.base_unit}
                            </span>
                          </td>
                          <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted">
                            {formatQuantity(row.quantity_on_hand)}
                          </td>
                          <td className="px-2 py-2.5 text-right align-top">
                            <input
                              type="number"
                              inputMode="decimal"
                              step="any"
                              min={0}
                              value={line?.counted ?? ''}
                              disabled={posting}
                              onChange={(e) =>
                                setCounted(row.inventory_item_id, e.target.value, {
                                  itemName: row.item_name,
                                  baseUnit: row.base_unit,
                                  onHand: row.quantity_on_hand,
                                })
                              }
                              aria-label={`Counted quantity for ${row.item_name}`}
                              className="w-24 rounded-lg border border-sand-border bg-white/70 px-2 py-1.5 text-right text-sm tabular-nums text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
                            />
                          </td>
                          <td
                            className={`px-2 py-2.5 text-right align-top font-semibold tabular-nums ${
                              difference === null
                                ? 'text-charcoal-muted'
                                : difference === 0
                                  ? 'text-charcoal-muted'
                                  : 'text-accent'
                            }`}
                          >
                            {difference === null
                              ? MISSING_VALUE
                              : difference === 0
                                ? 'Matches'
                                : `${difference > 0 ? '+' : ''}${formatQuantity(difference)}`}
                          </td>
                          <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted lg:table-cell">
                            {difference === null || difference === 0
                              ? MISSING_VALUE
                              : formatMoney(difference * cost, currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <Pagination
                page={list.page}
                pageSize={list.pageSize}
                totalCount={list.count}
                onPageChange={list.setPage}
                onPageSizeChange={list.setPageSize}
                disabled={list.loading || posting}
                itemNoun="items"
              />
            </>
          )}

          {/* What is about to be posted, across every page of the sheet. */}
          <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
            <p className="text-sm text-charcoal">
              {variances.length === 0 ? (
                <>
                  Nothing to record yet. Key a counted quantity beside an item and
                  its difference appears here.
                </>
              ) : (
                <>
                  <span className="font-semibold">
                    {variances.length}{' '}
                    {variances.length === 1 ? 'difference' : 'differences'}
                  </span>{' '}
                  ready to record in {location?.name ?? 'this location'} — counted
                  across every page of this sheet.
                </>
              )}
            </p>

            {posting ? (
              <p className="mt-2 text-xs text-charcoal-muted" aria-live="polite">
                Recording {progress.done} of {progress.total}…
              </p>
            ) : null}

            {failures.length > 0 ? (
              <div className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3">
                <p className="text-sm font-medium text-charcoal">
                  These lines were not recorded. They are still on your sheet, so
                  you can fix them and post again.
                </p>
                <ul className="mt-2 space-y-1">
                  {failures.map((f) => (
                    <li key={f.name} className="text-xs text-charcoal">
                      <span className="font-semibold">{f.name}</span> — {f.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void handlePost()}
                disabled={posting || variances.length === 0 || !location}
                className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                {posting ? 'Recording…' : 'Record the differences'}
              </button>
              <button
                type="button"
                onClick={() => {
                  setLines(new Map());
                  setFailures([]);
                }}
                disabled={posting || lines.size === 0}
                className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                Clear the sheet
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
