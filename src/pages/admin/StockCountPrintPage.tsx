import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { formatDisplayDate } from '../../lib/date';
import { describeError } from '../../lib/errors';
import {
  formatMoney,
  formatQuantity,
  formatSignedQuantity,
  MISSING_VALUE,
} from '../../lib/format';
import {
  fetchSheetForPrint,
  fetchTakeProgress,
} from '../../lib/stockTake';
import { takeStatusLabel } from '../../lib/stockTakeLabels';
import type { StockTakeProgressRow, StockTakeSheetRow } from '../../types/stockTake';

// Route: /admin/:propertySlug/inventory/counts/:takeId/print
//
// THE PAPER. Opened in a new tab from the count screen, and it is the one page
// in this module with no navigation, no tabs and no filters — because it is not
// a screen, it is a document that is about to be a piece of paper on a clipboard
// in a cold store.
//
// ----------------------------------------------------------------------------
// ONE ROUTE, TWO DOCUMENTS, DECIDED BY THE STATE
// ----------------------------------------------------------------------------
//   OPEN (or abandoned)  -> THE TALLY SHEET. Every shelf, in order, with a RULED
//                           BOX to write the count into and nothing else. This is
//                           what somebody carries round the store.
//   FINISHED (or reversed) -> THE VARIANCE REPORT. Expected, counted, difference
//                           and value, per line and in total — the document a
//                           manager signs off and files.
//
// Two buttons for two URLs would mean somebody printing the wrong one, and a
// tally sheet is only useful before a count while a variance report only exists
// after it. The state already knows which is which.
//
// ----------------------------------------------------------------------------
// THE PRINTED TALLY SHEET IS BLIND, AND NOT BY BEING CAREFUL HERE
// ----------------------------------------------------------------------------
// It reads the same view the screen does, and while a count is open that view
// sends no expected quantity at all (039 §4). So the paper cannot carry the
// answer even if this file tried to print it — which matters more here than
// anywhere else, because a printed sheet with the expected column on it would
// walk round the store being copied for years and nobody would ever see a bug.
//
// EVERY LINE, NOT A PAGE (rule 1a via fetchSheetForPrint). Pagination is a
// screen affordance; a count sheet that stopped at row 25 would send somebody to
// count a store with shelves missing from their list.

export function StockCountPrintPage() {
  const { takeId } = useParams<{ takeId: string }>();
  const { property } = useActiveProperty();

  const [take, setTake] = useState<StockTakeProgressRow | null>(null);
  const [rows, setRows] = useState<StockTakeSheetRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const tenantId = property?.tenant_id ?? null;
  const propertyId = property?.id ?? null;

  // The codebase's fetch shape: the async work lives in an IIFE inside the
  // effect with a `cancelled` flag, so a fast navigation cannot land a stale
  // response on a page that has moved on.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!tenantId || !propertyId || !takeId) return;
      setLoading(true);
      try {
        const [progress, lines] = await Promise.all([
          fetchTakeProgress(tenantId, propertyId, takeId),
          fetchSheetForPrint(tenantId, propertyId, takeId),
        ]);
        if (cancelled) return;
        setTake(progress);
        setRows(lines);
        setError(null);
      } catch (e) {
        // Rule 11: surfaced, never swallowed.
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, takeId]);

  if (!property) return null;

  if (loading) {
    return (
      <p className="px-6 py-16 text-center text-sm text-charcoal-muted" aria-live="polite">
        Preparing the sheet…
      </p>
    );
  }

  if (error || !take) {
    return (
      <p className="px-6 py-16 text-center text-sm text-charcoal">
        This count could not be loaded{error ? `: ${error}` : '.'}
      </p>
    );
  }

  const finished = take.status === 'finished' || take.status === 'reversed';

  return (
    <div className="mx-auto max-w-4xl px-4 py-6 print:max-w-none print:px-0 print:py-0">
      {/* The only control on the page, and it is not on the paper. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2 print:hidden">
        <p className="text-xs text-charcoal-muted">
          {finished
            ? 'The variance report for this count, ready to print, sign and file.'
            : 'The blank count sheet. Print it, walk the store, then key what you found.'}
        </p>
        <button
          type="button"
          onClick={() => window.print()}
          className="rounded-full bg-accent px-5 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Print
        </button>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* The letterhead. Every tenant value comes from the property row    */}
      {/* (rule 17) — there is no hotel name written anywhere in this file. */}
      {/* ---------------------------------------------------------------- */}
      <header className="border-b-2 border-charcoal pb-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-charcoal">{property.name}</h1>
            <p className="mt-0.5 text-sm text-charcoal">
              {finished ? 'Stock count — variance report' : 'Stock count sheet'}
            </p>
          </div>
          <div className="text-right text-sm text-charcoal">
            <p className="font-bold">{take.take_number}</p>
            <p>{take.location_name}</p>
            {/* Rules 8/12: the operating day the count belongs to. */}
            <p>{formatDisplayDate(take.business_date)}</p>
          </div>
        </div>

        <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-charcoal sm:grid-cols-4">
          <div>
            <dt className="text-charcoal-muted">Status</dt>
            <dd className="font-semibold">{takeStatusLabel(take.status)}</dd>
          </div>
          <div>
            <dt className="text-charcoal-muted">Shelves on this sheet</dt>
            <dd className="font-semibold">{take.line_count}</dd>
          </div>
          <div>
            <dt className="text-charcoal-muted">Counted</dt>
            <dd className="font-semibold">{take.counted_count}</dd>
          </div>
          <div>
            <dt className="text-charcoal-muted">Not counted</dt>
            <dd className="font-semibold">{take.uncounted_count}</dd>
          </div>
        </dl>

        {take.note ? (
          <p className="mt-2 text-xs text-charcoal">Note: {take.note}</p>
        ) : null}
      </header>

      {finished ? (
        <PrintedVarianceReport rows={rows} take={take} currency={property.currency} />
      ) : (
        <PrintedTallySheet rows={rows} />
      )}

      {/* ---------------------------------------------------------------- */}
      {/* Signatures. On paper this is the whole control: two people, two    */}
      {/* names, one sheet. The system's version of that is two logins, and  */}
      {/* until a hotel has them the paper is what carries it.               */}
      {/* ---------------------------------------------------------------- */}
      <footer className="mt-8 grid gap-6 sm:grid-cols-2">
        <SignatureLine label="Counted by" />
        <SignatureLine label={finished ? 'Approved by' : 'Checked by'} />
      </footer>

      <p className="mt-6 text-[10px] leading-relaxed text-charcoal-muted">
        {finished
          ? 'Every difference on this report was recorded as a stock movement when the count was finished, valued at the cost the stock moved at on that day. Movements cannot be edited or deleted; a count that was wrong is undone by reversing it, which leaves both the count and its reversal on file.'
          : 'Write the quantity you actually find, in the unit shown. Leave a line BLANK if you have not counted that shelf — a blank means “not counted” and changes nothing. Write 0 only when you have looked and there is none, which writes the whole expected quantity off.'}
      </p>
    </div>
  );
}

function SignatureLine({ label }: { label: string }) {
  return (
    <div>
      <div className="h-10 border-b border-charcoal" />
      <p className="mt-1 text-xs text-charcoal-muted">
        {label} — name, signature and date
      </p>
    </div>
  );
}

// THE BLANK SHEET. A ruled box per line, wide enough to write a number in with a
// biro, and a second one for a note ("2 cases + 3 loose") — because the person
// holding this has no keyboard and no way to explain an odd figure otherwise.
function PrintedTallySheet({ rows }: { rows: StockTakeSheetRow[] }) {
  return (
    <table className="mt-4 w-full border-collapse text-sm">
      <thead>
        <tr className="border-b border-charcoal text-left">
          <th scope="col" className="py-1.5 pr-2 text-xs font-bold text-charcoal">
            #
          </th>
          <th scope="col" className="py-1.5 pr-2 text-xs font-bold text-charcoal">
            Item
          </th>
          <th scope="col" className="py-1.5 pr-2 text-xs font-bold text-charcoal">
            Unit
          </th>
          <th scope="col" className="w-28 py-1.5 pr-2 text-xs font-bold text-charcoal">
            Counted
          </th>
          <th scope="col" className="w-40 py-1.5 text-xs font-bold text-charcoal">
            Notes
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={row.line_id} className="break-inside-avoid border-b border-sand-border">
            <td className="py-2 pr-2 align-middle text-xs text-charcoal-muted">
              {index + 1}
            </td>
            <td className="py-2 pr-2 align-middle">
              <span className="block font-medium text-charcoal">{row.item_name}</span>
              {row.item_code ? (
                <span className="block text-[10px] text-charcoal-muted">
                  {row.item_code}
                </span>
              ) : null}
            </td>
            <td className="py-2 pr-2 align-middle text-xs text-charcoal">
              {row.base_unit}
            </td>
            <td className="py-2 pr-2 align-middle">
              {/* A BOX, not a blank space: an unruled gap gets written across
                  and the next line becomes unreadable. If the shelf was already
                  counted on screen, the figure is printed IN the box so the
                  paper and the system agree. */}
              <span className="flex h-8 items-center justify-end rounded border border-charcoal/60 px-2 text-sm tabular-nums text-charcoal">
                {row.is_counted ? formatQuantity(row.counted_quantity) : ''}
              </span>
            </td>
            <td className="py-2 align-middle">
              <span className="block h-8 border-b border-sand-border" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// THE FINISHED REPORT, on paper. The same columns the screen shows, in the same
// order, from the same view — a second arrangement of the same numbers is how a
// printed report comes to disagree with the screen it was printed from.
function PrintedVarianceReport({
  rows,
  take,
  currency,
}: {
  rows: StockTakeSheetRow[];
  take: StockTakeProgressRow;
  currency: string;
}) {
  return (
    <>
      <table className="mt-4 w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-charcoal text-left">
            <th scope="col" className="py-1.5 pr-2 text-xs font-bold text-charcoal">
              Item
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right text-xs font-bold text-charcoal">
              Expected
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right text-xs font-bold text-charcoal">
              Counted
            </th>
            <th scope="col" className="py-1.5 pr-2 text-right text-xs font-bold text-charcoal">
              Difference
            </th>
            <th scope="col" className="py-1.5 text-right text-xs font-bold text-charcoal">
              Value
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            // §6: every figure arrives as a STRING. Parsed once, and only to
            // decide what to print — never to recompute the difference, which is
            // the server's own column.
            const difference = row.variance_quantity;
            return (
              <tr key={row.line_id} className="break-inside-avoid border-b border-sand-border">
                <td className="py-1.5 pr-2 align-top">
                  <span className="block text-charcoal">{row.item_name}</span>
                  {row.movement_reversed ? (
                    <span className="block text-[10px] font-semibold text-charcoal-muted">
                      reversed
                    </span>
                  ) : null}
                </td>
                <td className="py-1.5 pr-2 text-right align-top tabular-nums text-charcoal">
                  {formatQuantity(row.expected_quantity)}
                </td>
                <td className="py-1.5 pr-2 text-right align-top tabular-nums text-charcoal">
                  {row.counted_quantity === null
                    ? 'not counted'
                    : formatQuantity(row.counted_quantity)}
                </td>
                <td className="py-1.5 pr-2 text-right align-top tabular-nums font-semibold text-charcoal">
                  {difference === null
                    ? MISSING_VALUE
                    : difference === 0
                      ? '—'
                      : formatSignedQuantity(row.variance_quantity)}
                </td>
                <td className="py-1.5 text-right align-top tabular-nums text-charcoal">
                  {difference === null || difference === 0
                    ? MISSING_VALUE
                    : formatMoney(row.variance_value, currency)}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-charcoal">
            <td colSpan={3} className="py-2 pr-2 text-right text-xs font-bold text-charcoal">
              Change in stock value
            </td>
            <td className="py-2 pr-2 text-right text-xs text-charcoal-muted">
              {take.variance_count ?? MISSING_VALUE} lines
            </td>
            <td className="py-2 text-right text-sm font-bold tabular-nums text-charcoal">
              {formatMoney(take.net_variance_value, currency)}
            </td>
          </tr>
        </tfoot>
      </table>

      {take.status === 'reversed' ? (
        <p className="mt-3 border border-charcoal/40 p-2 text-xs text-charcoal">
          <strong>This count was reversed.</strong>{' '}
          {take.reverse_reason ? `${take.reverse_reason}. ` : ''}
          Every movement it posted has been undone, so the figures above are what
          the count found rather than what the stock now stands at.
        </p>
      ) : null}
    </>
  );
}
