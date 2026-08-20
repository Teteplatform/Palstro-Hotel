import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useInventoryReference } from '../../hooks/useInventoryReference';
import { useLocations } from '../../hooks/useLocations';
import { ItemDetailScreen } from '../../components/admin/inventory/ItemDetailScreen';
import { ArrowLeftIcon } from '../../components/ui/icons';
import { describeError } from '../../lib/errors';
import { fetchInventoryItemsByIds } from '../../lib/inventory';
import type { InventoryItem } from '../../types/inventory';

// Route: /admin/:propertySlug/inventory/items/:itemId
//
// ONE ITEM, ON ITS OWN PAGE — the sibling of the count page, and shaped like it
// on purpose. An item was an expanding row in a paginated table inside a tab
// strip; looking into one is a ten-minute job, and everything around that row was
// about a hundred other items.
//
// The three things worth copying from StockCountPage, each for its own reason:
//   * the way back is a REAL LINK rather than history, because this page is
//     deep-linkable and "back" has to mean somewhere;
//   * the fetch is an IIFE inside the effect with a `cancelled` flag, so a fast
//     navigation cannot land a stale item on a page that has moved on;
//   * the screen is KEYED BY PROPERTY, so switching hotel remounts cleanly rather
//     than showing one property's stock under another property's name.
//
// THE SCOPE LIVES IN THE URL, not in component state. Stock is per location, so a
// figure on this page is meaningless without one — and holding it in state would
// make "look at the rice in the kitchen" un-sendable and lose it on a refresh. It
// is the same convention the inventory tab strip already uses for `?tab=`.
export function InventoryItemPage() {
  const { itemId } = useParams<{ itemId: string }>();
  const { property } = useActiveProperty();
  const [searchParams, setSearchParams] = useSearchParams();

  const tenantId = property?.tenant_id ?? null;
  const propertyId = property?.id ?? null;
  const propertySlug = property?.slug ?? '';

  const locations = useLocations(propertyId, tenantId);
  const reference = useInventoryReference(tenantId);

  const [item, setItem] = useState<InventoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // '' / absent = every location in this property. The same meaning the products
  // list gives an empty location, so the two screens cannot disagree about it.
  const locationId = searchParams.get('location') || null;

  const setScope = useCallback(
    (next: string | null) => {
      // replace, not push: changing which shelf you are looking at is a view of one
      // page, and pushing would make Back walk the location picker instead of
      // leaving the item.
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next) params.set('location', next);
          else params.delete('location');
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const reloadItem = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!tenantId || !itemId) return;
      setLoading(true);
      try {
        // fetchInventoryItemsByIds INCLUDES soft-deleted items on purpose (it is
        // what lets a movement against a retired item still render its name), which
        // is right here too: an item removed from the catalogue still has a history
        // worth opening, and a 404 would lose it.
        const [row] = await fetchInventoryItemsByIds(tenantId, [itemId]);
        if (cancelled) return;
        setItem(row ?? null);
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
  }, [tenantId, itemId, nonce]);

  if (!property) return null;

  const backHref = `/admin/${propertySlug}/inventory`;

  if (loading) {
    return (
      <div
        className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
        aria-busy="true"
        aria-live="polite"
      >
        <span className="sr-only">Loading the item…</span>
        <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
      </div>
    );
  }

  if (error || !item) {
    return (
      <div className="space-y-4">
        <Link
          to={backHref}
          className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          All products
        </Link>
        <p className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center text-sm text-charcoal-muted">
          {error
            ? `This item could not be loaded: ${error}`
            : 'That item does not exist, or it belongs to another hotel.'}
        </p>
      </div>
    );
  }

  return (
    <ItemDetailScreen
      key={`${property.id}:${item.id}`}
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={propertySlug}
      currency={property.currency}
      timezone={property.timezone}
      item={item}
      locations={locations.rows}
      locationId={locationId}
      onScopeChange={setScope}
      onItemChanged={async () => {
        await Promise.all([reloadItem(), reference.reload()]);
      }}
      units={reference.units}
      categories={reference.categories}
      referenceLoading={reference.loading}
    />
  );
}
