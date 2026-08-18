import { useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { CalculationNote } from '../../ui/CalculationNote';
import { ActionMenu } from '../../ui/ActionMenu';
import { Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { ManagerPinField } from '../ManagerPinField';
import { useStockTakeSheet } from '../../../hooks/useStockTakeSheet';
import { formatDisplayDate } from '../../../lib/date';
import {
  formatMoney,
  formatQuantity,
  formatSignedQuantity,
  MISSING_VALUE,
} from '../../../lib/format';
import {
  newIdempotencyKey,
  reverseStockTake,
  stockErrorMessage,
} from '../../../lib/stockTake';
import {
  COUNT_VARIANCE_EXPLANATION,
  COUNT_VARIANCE_SIGN_EXPLANATION,
  REVERSE_COUNT_EXPLANATION,
  REVERSE_COUNT_PIN_LEAD,
  REVERSE_COUNT_PIN_REASON,
  REVERSE_COUNT_PIN_TITLE,
  takeStatusLabel,
  takeStatusTone,
} from '../../../lib/stockTakeLabels';
import type { InventoryCategory } from '../../../types/inventory';
import type { StockTakeProgressRow, StockTakeSheetRow } from '../../../types/stockTake';

// THE VARIANCE REPORT — what a finished count found, per line and in total.
//
// ---------------------------------------------------------------------------
// THE SAME VIEW, THE SAME ROWS, DIFFERENT COLUMNS
// ---------------------------------------------------------------------------
// This reads stock_take_sheet, exactly as the open sheet does. It is not a
// second query against a "variance report" view, because a second definition of
// what a variance is would drift from the first the day either changed — and
// then the report a manager approved would disagree with the report they read
// back a month later, with nothing erroring.
//
// ---------------------------------------------------------------------------
// EVERY NUMBER BELOW COMES FROM THE SERVER, INCLUDING THE DIFFERENCE
// ---------------------------------------------------------------------------
// The difference is not `counted - expected` computed here. It is the view's own
// column, folded from the same two figures the movement was posted from, and the
// value beside it is the difference at the cost the stock ACTUALLY moved at —
// stamped when the count was finished and never recalculated (039 §3). A moving
// average is path-dependent, so a value recomputed today would quietly disagree
// with the one the approving manager saw.
//
// ---------------------------------------------------------------------------
// WHAT THE MENU OFFERS, AND WHAT IT DELIBERATELY DOES NOT
// ---------------------------------------------------------------------------
// Print, and — on a finished count — Undo. There is NO DELETE, and that is not
// an omission: a finished count moved real stock and a manager approved it, so
// removing the record would remove the evidence that both happened. An OPEN
// count is abandoned (it posted nothing); a FINISHED one is undone by reversing
// every movement it made. Two states, two acts, and both leave the document
// readable forever.

interface CountVarianceReportProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  take: StockTakeProgressRow;
  currency: string;
  categories: InventoryCategory[];
  // Re-read the document after it changes state, so the page shows the server's
  // version rather than this component's guess at it.
  onChanged: () => Promise<void> | void;
  onBack: () => void;
}

export function CountVarianceReport({
  tenantId,
  propertyId,
  propertySlug,
  take,
  currency,
  categories,
  onChanged,
  onBack,
}: CountVarianceReportProps) {
  const toast = useToast();
  const sheet = useStockTakeSheet(tenantId, propertyId, take.stock_take_id);

  const [reverseOpen, setReverseOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const [reversing, setReversing] = useState(false);
  const [reverseError, setReverseError] = useState<string | null>(null);

  const finished = take.status === 'finished';
  const reversed = take.status === 'reversed';
  const cancelled = take.status === 'cancelled';
  const showsFigures = finished || reversed;

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  const printUrl = `/admin/${propertySlug}/inventory/counts/${take.stock_take_id}/print`;

  async function handleReverse() {
    setReversing(true);
    setReverseError(null);
    try {
      await reverseStockTake({
        stockTakeId: take.stock_take_id,
        reason,
        managerPin: pin,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`Count ${take.take_number} was undone.`);
      setReverseOpen(false);
      setReason('');
      await onChanged();
    } catch (e) {
      // Rule 21: the server's own sentence and hint, verbatim.
      setReverseError(stockErrorMessage(e));
    } finally {
      // Held for one call, cleared either way, stored nowhere.
      setPin('');
      setReversing(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-charcoal">
              Count {take.take_number}
            </h2>
            <p className="mt-0.5 text-sm text-charcoal-muted">
              {take.location_name} ·{' '}
              {/* Rule 8/12: the operating day the count belongs to, never the
                  timestamp it happened to be finished at. */}
              counted {formatDisplayDate(take.business_date)}
              {take.note ? ` · ${take.note}` : ''}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2 print:hidden">
            <span
              className={`rounded-full px-3 py-1 text-xs font-semibold ${takeStatusTone(
                take.status,
              )}`}
            >
              {takeStatusLabel(take.status)}
            </span>
            <a
              href={printUrl}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Print
            </a>
            <ActionMenu
              label={`Actions for count ${take.take_number}`}
              items={[
                {
                  key: 'print',
                  label: 'Print or save as PDF',
                  hint: 'Opens the report on its own page, ready to print or sign.',
                  onSelect: () => window.open(printUrl, '_blank', 'noreferrer'),
                },
                ...(finished
                  ? [
                      {
                        key: 'reverse',
                        label: 'Undo this count',
                        hint: 'Puts every shelf back. Needs a manager’s PIN and a reason.',
                        tone: 'danger' as const,
                        onSelect: () => setReverseOpen(true),
                      },
                    ]
                  : []),
              ]}
            />
          </div>
        </div>

        {/* How many were counted and how many were not — stated plainly on the
            finished document rather than hidden in a tooltip. */}
        <p className="mt-3 text-sm text-charcoal">
          <span className="font-semibold">{take.counted_count}</span> of{' '}
          <span className="font-semibold">{take.line_count}</span> shelves were
          counted
          {take.uncounted_count > 0 ? (
            <>
              {' '}
              · <span className="font-semibold">{take.uncounted_count}</span>{' '}
              were not, and were left untouched
            </>
          ) : null}
          .
        </p>

        {showsFigures ? (
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <Figure
              label="Lines with a difference"
              note={COUNT_VARIANCE_EXPLANATION}
              value={
                take.variance_count === null
                  ? MISSING_VALUE
                  : String(take.variance_count)
              }
            />
            <Figure
              label="Change in stock value"
              note={COUNT_VARIANCE_SIGN_EXPLANATION}
              value={formatMoney(take.net_variance_value, currency)}
            />
            <Figure
              label="Size of the discrepancy"
              note={COUNT_VARIANCE_EXPLANATION}
              value={formatMoney(take.absolute_variance_value, currency)}
            />
          </dl>
        ) : null}

        {cancelled ? (
          <p className="mt-3 rounded-xl border border-sand-border bg-sand/30 p-3 text-xs text-charcoal">
            This count was abandoned
            {take.cancel_reason ? `: ${take.cancel_reason}` : ''}. Nothing was
            posted and no stock changed. What was counted before it was abandoned
            is listed below; what the system expected stays hidden, because
            abandoning a count is not a way to read it.
          </p>
        ) : null}

        {reversed ? (
          <p className="mt-3 rounded-xl border border-primary/40 bg-primary/5 p-3 text-xs text-charcoal">
            <strong>This count was undone.</strong>{' '}
            {take.reverse_reason ? `${take.reverse_reason}. ` : ''}
            Every movement it posted has been reversed, so the figures above are
            what the count <em>found</em> rather than what the stock stands at
            now. Both the count and its undoing stay on file.
          </p>
        ) : null}

        {/* When SOME lines were reversed on their own from the item ledger, the
            document's status cannot say so — which is exactly the case worth
            surfacing rather than leaving somebody to reconcile by eye. */}
        {finished && take.reversed_movement_count > 0 ? (
          <p className="mt-3 rounded-xl border border-sand-border bg-sand/30 p-3 text-xs text-charcoal">
            <strong>
              {take.reversed_movement_count} of {take.movement_count}
            </strong>{' '}
            movements from this count have since been reversed individually, from
            the item’s own movement list. The report below still shows what the
            count found; the lines marked <em>reversed</em> no longer stand.
          </p>
        ) : null}
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* Undoing the count                                                */}
      {/* ---------------------------------------------------------------- */}
      {reverseOpen ? (
        <div className="rounded-2xl border-2 border-primary/40 bg-white/60 p-4 print:hidden">
          <h3 className="text-sm font-semibold text-charcoal">
            Undo count {take.take_number}
          </h3>
          <p className="mt-1 max-w-2xl text-xs text-charcoal-muted">
            {REVERSE_COUNT_EXPLANATION}
          </p>

          <div className="mt-3">
            <TextField
              label="Why is it being undone?"
              required
              value={reason}
              onChange={setReason}
              placeholder="e.g. The bar was counted as cases, not bottles"
              disabled={reversing}
              helpText="Recorded permanently against your name and the approving manager’s."
            />
          </div>

          <div className="mt-3">
            <ManagerPinField
              value={pin}
              onChange={setPin}
              disabled={reversing}
              title={REVERSE_COUNT_PIN_TITLE}
              lead={REVERSE_COUNT_PIN_LEAD}
              reason={REVERSE_COUNT_PIN_REASON}
            />
          </div>

          {reverseError ? (
            <p className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm text-charcoal">
              {reverseError}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleReverse()}
              disabled={reversing}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {reversing ? 'Undoing…' : 'Undo the count'}
            </button>
            <button
              type="button"
              onClick={() => {
                setReverseOpen(false);
                setReverseError(null);
                setPin('');
              }}
              disabled={reversing}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 print:hidden">
        <TextField
          label="Find an item"
          value={sheet.filters.search}
          onChange={(v) => sheet.setFilters({ ...sheet.filters, search: v })}
          placeholder="Name or code"
        />
        <Select
          label="Category"
          value={sheet.filters.categoryId}
          onChange={(v) => sheet.setFilters({ ...sheet.filters, categoryId: v })}
          options={categoryOptions}
        />
      </div>

      {sheet.error ? (
        <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
          We couldn’t load this count: {sheet.error.message}
        </p>
      ) : sheet.loading && sheet.rows.length === 0 ? (
        <div
          className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only">Loading the count…</span>
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-sand-border bg-white/60">
            <table className="w-full border-collapse text-sm sm:min-w-[44rem]">
              <thead>
                <tr className="border-b border-sand-border bg-sand/40 text-left">
                  <th scope="col" className="px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4">
                    Item
                  </th>
                  <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
                    Expected
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
                {sheet.rows.map((row) => (
                  <VarianceRow key={row.line_id} row={row} currency={currency} />
                ))}
              </tbody>
            </table>
          </div>

          <Pagination
            page={sheet.page}
            pageSize={sheet.pageSize}
            totalCount={sheet.count}
            onPageChange={sheet.setPage}
            onPageSizeChange={sheet.setPageSize}
            disabled={sheet.loading}
            itemNoun="shelves"
          />
        </>
      )}

      <button
        type="button"
        onClick={onBack}
        className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream print:hidden"
      >
        Back to counts
      </button>
    </div>
  );
}

function Figure({
  label,
  note,
  value,
}: {
  label: string;
  note: string;
  value: string;
}) {
  return (
    <div className="rounded-xl border border-sand-border bg-white/70 p-3">
      <dt className="flex items-center gap-1.5 text-xs text-charcoal-muted">
        {label}
        <CalculationNote note={note} />
      </dt>
      <dd className="mt-1 text-lg font-semibold tabular-nums text-charcoal">
        {value}
      </dd>
    </div>
  );
}

// ONE LINE OF A FINISHED COUNT, extracted as a seam for the render proof (rule
// 22), exactly as LedgerRow is. It is the SAME component the report renders;
// there is no second copy to drift.
//
// THE THREE SHAPES IT MUST GET RIGHT, all of which a SQL proof is blind to:
//   * expected_quantity NULL     -> the count is not finished (or was
//     abandoned). Renders as the shared em-dash, NEVER as 0.
//   * counted_quantity NULL      -> nobody counted that shelf. Renders in words,
//     never as 0, and its difference is a dash rather than the full quantity.
//   * a counted ZERO             -> renders as 0 with a difference of the FULL
//     expected quantity, which is the single most consequential line a count
//     can produce.
export function VarianceRow({
  row,
  currency,
}: {
  row: StockTakeSheetRow;
  currency: string;
}) {
  // Numbers or null (rule 24). NULL is meaningful on both: a variance is blind
  // until the count is finished, and an uncounted line has no counted quantity.
  // Nothing here is recomputed from the other columns.
  const difference = row.variance_quantity;
  const counted = row.counted_quantity;

  return (
    <tr>
      <td className="px-3 py-2.5 align-top sm:px-4">
        <span className="block font-medium text-charcoal">{row.item_name}</span>
        <span className="mt-0.5 block text-xs text-charcoal-muted">
          {row.item_code ? `${row.item_code} · ` : ''}in {row.base_unit}
        </span>
        {/* A line whose movement has been undone — by the whole count being
            reversed, or by that one movement being reversed from the item's
            ledger. Said on the line, because the document's status cannot
            distinguish the second case. */}
        {row.movement_reversed ? (
          <span className="mt-0.5 block text-xs font-semibold text-primary">
            Reversed — this difference no longer stands
          </span>
        ) : null}
      </td>
      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted">
        {/* NULL here means the figure was never sent (039 §4), not zero. */}
        {formatQuantity(row.expected_quantity)}
      </td>
      <td className="px-2 py-2.5 text-right align-top tabular-nums text-charcoal">
        {counted === null ? (
          <span className="text-xs text-charcoal-muted">Not counted</span>
        ) : (
          formatQuantity(counted)
        )}
      </td>
      <td
        className={`px-2 py-2.5 text-right align-top font-semibold tabular-nums ${
          difference === null || difference === 0
            ? 'text-charcoal-muted'
            : 'text-accent'
        }`}
      >
        {difference === null
          ? MISSING_VALUE
          : difference === 0
            ? 'Matches'
            : formatSignedQuantity(row.variance_quantity)}
      </td>
      <td className="hidden px-2 py-2.5 text-right align-top tabular-nums text-charcoal-muted lg:table-cell">
        {difference === null || difference === 0
          ? MISSING_VALUE
          : formatMoney(row.variance_value, currency)}
      </td>
    </tr>
  );
}
