import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useInventoryReference } from '../../hooks/useInventoryReference';
import { CountSheet } from '../../components/admin/inventory/CountSheet';
import { CountVarianceReport } from '../../components/admin/inventory/CountVarianceReport';
import { ArrowLeftIcon } from '../../components/ui/icons';
import { describeError } from '../../lib/errors';
import { fetchTakeProgress } from '../../lib/stockTake';
import type { StockTakeProgressRow } from '../../types/stockTake';

// Route: /admin/:propertySlug/inventory/counts/:takeId
//
// ONE COUNT, ON ITS OWN PAGE. It used to live inside the Inventory screen's tab
// row, under the module header and the location picker, and that was wrong in a
// way that only becomes obvious with a real sheet on screen: a person counting a
// store is doing ONE job for the next two hours, and every pixel of tab strip
// above it is an invitation to lose the sheet by clicking something.
//
// The same three reasons the booking detail and the statement became routes
// apply here, and the third is the one that matters most for a count:
//   * it can be LINKED TO — "finish ST-000004" is a URL somebody can be sent;
//   * it survives a REFRESH into the same place, which is the whole promise of
//     making the count a document in the first place;
//   * it PRINTS cleanly — AdminLayout's chrome is print:hidden — and the printed
//     sheet is a separate route again, because paper for the store and paper for
//     the file are different documents.
//
// WHICH DOCUMENT IS DECIDED BY THE STATE, not by a prop or a tab:
//   open                    -> the count sheet, for counting.
//   finished / reversed     -> the variance report.
//   cancelled               -> the same report, showing what was counted before
//                              it was abandoned and nothing else (039 §4 keeps an
//                              abandoned count's expected figures hidden for
//                              good, so there is no variance to show).
export function StockCountPage() {
  const { takeId } = useParams<{ takeId: string }>();
  const { property } = useActiveProperty();
  const navigate = useNavigate();

  const [take, setTake] = useState<StockTakeProgressRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const tenantId = property?.tenant_id ?? null;
  const propertyId = property?.id ?? null;
  const propertySlug = property?.slug ?? '';

  // The categories the sheet filters by. Tenant-level reference data, shared
  // with the rest of the module rather than fetched a second way here.
  const reference = useInventoryReference(tenantId);

  // Re-read the document. Called after the count changes state — finished,
  // abandoned or undone — so the page shows the SERVER's version of what just
  // happened rather than this screen's guess at it.
  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // The codebase's fetch shape (useStockOnHand and every sibling): the async
  // work lives in an IIFE inside the effect with a `cancelled` flag, so a
  // property switch or a fast navigation cannot land a stale response on a
  // screen that has moved on.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (!tenantId || !propertyId || !takeId) return;
      setLoading(true);
      try {
        const row = await fetchTakeProgress(tenantId, propertyId, takeId);
        if (cancelled) return;
        setTake(row);
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
  }, [tenantId, propertyId, takeId, nonce]);

  if (!property) return null;

  const backToCounts = `/admin/${propertySlug}/inventory?tab=stock_take`;

  return (
    <div className="space-y-4">
      {/* The way back is a real link, not browser history: this page is
          deep-linkable, so "back" has to mean somewhere rather than wherever the
          person happened to come from. print:hidden — navigation on paper is
          noise. */}
      <Link
        to={backToCounts}
        className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream print:hidden"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        All counts
      </Link>

      {loading ? (
        <div
          className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
          aria-busy="true"
          aria-live="polite"
        >
          <span className="sr-only">Loading the count…</span>
          <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
        </div>
      ) : error ? (
        <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal">
          This count could not be loaded: {error}
        </p>
      ) : !take ? (
        <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
          That count does not exist, or it belongs to another hotel.
        </p>
      ) : take.status === 'open' ? (
        <CountSheet
          tenantId={property.tenant_id}
          propertyId={property.id}
          propertySlug={propertySlug}
          take={take}
          categories={reference.categories}
          onClosed={async () => {
            // Re-read rather than assume: the same page now shows the variance
            // report, and it shows the SERVER's version of what just happened.
            await reload();
          }}
        />
      ) : (
        <CountVarianceReport
          tenantId={property.tenant_id}
          propertyId={property.id}
          propertySlug={propertySlug}
          take={take}
          currency={property.currency}
          categories={reference.categories}
          onChanged={reload}
          onBack={() => navigate(backToCounts)}
        />
      )}
    </div>
  );
}
