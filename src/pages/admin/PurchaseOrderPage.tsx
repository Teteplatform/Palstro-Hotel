import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { PurchaseOrderScreen } from '../../components/admin/purchasing/PurchaseOrderScreen';
import { PurchaseOrderForm } from '../../components/admin/purchasing/PurchaseOrderForm';
import { describeError } from '../../lib/errors';
import { todayIsoInZone } from '../../lib/date';
import { fetchInventoryItemsByIds, fetchLocations, pickDefaultLocation } from '../../lib/inventory';
import { fetchPurchaseOrder, fetchPurchaseOrderLines } from '../../lib/purchasing';
import type { InventoryItem } from '../../types/inventory';
import type {
  PurchaseOrderLineStatus,
  PurchaseOrderSummary,
} from '../../types/purchasing';

// Routes:
//   /admin/:slug/purchases/new           raise one
//   /admin/:slug/purchases/:id           read it, and RECEIVE against it
//   /admin/:slug/purchases/:id/edit      change a draft
//
// ONE PAGE COMPONENT FOR THREE ROUTES, because they share the same fetch and
// differ only in what they render with it. Splitting them would mean the edit
// route re-fetching what the detail route just had, and two places that decide
// what "the default store" is.
//
// THE EDIT ROUTE IS A COURTESY, NOT A GUARD. It sends a non-draft straight back
// to the read view rather than rendering a form whose every save would be
// refused — but save_purchase_order is what actually refuses, by name, so
// somebody who types the URL gets the database's sentence rather than silence.

interface PurchaseOrderPageProps {
  mode: 'new' | 'view' | 'edit';
}

export function PurchaseOrderPage({ mode }: PurchaseOrderPageProps) {
  const { property } = useActiveProperty();
  const params = useParams();
  const navigate = useNavigate();
  const orderId = params.purchaseOrderId ?? null;

  const [order, setOrder] = useState<PurchaseOrderSummary | null>(null);
  const [lines, setLines] = useState<PurchaseOrderLineStatus[]>([]);
  const [itemsById, setItemsById] = useState<Map<string, InventoryItem>>(new Map());
  const [defaultLocationId, setDefaultLocationId] = useState<string | null>(null);
  const [loading, setLoading] = useState(mode !== 'view');
  const [error, setError] = useState<string | null>(null);

  const propertyId = property?.id ?? null;
  const tenantId = property?.tenant_id ?? null;

  // Only the FORM modes need this: the detail screen fetches its own.
  useEffect(() => {
    if (mode === 'view' || !propertyId || !tenantId) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const locations = await fetchLocations(tenantId, propertyId);
        if (cancelled) return;
        setDefaultLocationId(pickDefaultLocation(locations)?.id ?? null);

        if (mode === 'edit' && orderId) {
          const [o, l] = await Promise.all([
            fetchPurchaseOrder(orderId),
            fetchPurchaseOrderLines(orderId),
          ]);
          if (cancelled) return;
          setOrder(o);
          setLines(l);

          // The catalogue rows behind THIS order's lines, so each picker can
          // label a choice made in a previous session. Bounded by the order's
          // own line count (rule 1a) — never an unbounded .in().
          const ids = [
            ...new Set(l.map((x) => x.inventory_item_id).filter((x): x is string => Boolean(x))),
          ];
          const items = ids.length > 0 ? await fetchInventoryItemsByIds(tenantId, ids) : [];
          if (cancelled) return;
          setItemsById(new Map(items.map((i) => [i.id, i])));
        }
        setError(null);
      } catch (e) {
        if (!cancelled) setError(describeError(e)); // rule 11
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mode, orderId, propertyId, tenantId]);

  if (!property) return null;
  const today = todayIsoInZone(property.timezone);

  if (mode === 'view') {
    if (!orderId) return null;
    return (
      <PurchaseOrderScreen
        key={orderId}
        propertySlug={property.slug}
        currency={property.currency}
        today={today}
        purchaseOrderId={orderId}
      />
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
        <p className="text-sm font-medium text-charcoal">
          This purchase order could not be loaded.
        </p>
        <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
      </div>
    );
  }

  if (loading) {
    return <p className="py-10 text-center text-sm text-charcoal-muted">Loading…</p>;
  }

  // A SENT ORDER IS NOT EDITABLE. Sent back to the read view rather than shown a
  // form that cannot save — the server is still what refuses.
  if (mode === 'edit' && order && order.status !== 'draft') {
    return (
      <PurchaseOrderScreen
        key={order.id}
        propertySlug={property.slug}
        currency={property.currency}
        today={today}
        purchaseOrderId={order.id}
      />
    );
  }

  return (
    <PurchaseOrderForm
      tenantId={property.tenant_id}
      propertyId={property.id}
      propertySlug={property.slug}
      currency={property.currency}
      timezone={property.timezone}
      today={today}
      defaultLocationId={defaultLocationId}
      order={mode === 'edit' ? order : null}
      existingLines={mode === 'edit' ? lines : []}
      itemsById={itemsById}
      onSaved={(id) => navigate(`/admin/${property.slug}/purchases/${id}`)}
      onCancel={() => navigate(`/admin/${property.slug}/purchases`)}
    />
  );
}
