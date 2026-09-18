import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { describeError } from '../../../lib/errors';
import { formatDisplayDate } from '../../../lib/date';
import { formatMoney } from '../../../lib/format';
import { fetchSupplierActivity } from '../../../lib/suppliers';
import {
  NO_ACTIVITY_YET,
  purchaseStatusLabel,
  purchaseStatusTone,
  SUPPLIER_ACTIVITY_ABOUT,
  SUPPLIER_ACTIVITY_ABOUT_TITLE,
} from '../../../lib/purchasingLabels';
import type { Supplier, SupplierActivityRow } from '../../../types/purchasing';

// WHAT THIS HOTEL HAS ORDERED FROM ONE SUPPLIER, AND WHAT ARRIVED.
//
// ---------------------------------------------------------------------------
// THERE IS NO BALANCE ON THIS PANEL, AND ITS ABSENCE IS THE DESIGN
// ---------------------------------------------------------------------------
// Every delivery credits supplier_payable, and nothing in this shipment ever
// debits it — supplier payments are 1.1h5. So a column headed "owed", computed
// from receipts alone, would be correct until the first payment and silently
// wrong from then on, forever, on a screen an owner trusts.
//
// The view behind this is called supplier_activity rather than supplier_account
// for exactly that reason, and the ⓘ says so out loud: an absence somebody can
// see the reasoning for is a decision, and an absence they cannot is an
// oversight they will work around.
//
// The three figures shown — ordered, arrived, still outstanding — are each about
// GOODS, not money owed, and none of them totals into anything that looks like a
// statement.

interface SupplierActivityPanelProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  supplier: Supplier;
}

export function SupplierActivityPanel({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  supplier,
}: SupplierActivityPanelProps) {
  const [rows, setRows] = useState<SupplierActivityRow[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchSupplierActivity(tenantId, propertyId, supplier.id);
        if (cancelled) return;
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setError(describeError(e)); // rule 11 — surfaced, never swallowed
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, supplier.id]);

  return (
    <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
      <ScreenHeader
        level={2}
        title={supplier.name}
        purpose="What this hotel has ordered from them, and what arrived."
        about={{
          title: SUPPLIER_ACTIVITY_ABOUT_TITLE,
          paragraphs: SUPPLIER_ACTIVITY_ABOUT,
          guideAnchor: 'suppliers',
          guideLabel: 'Suppliers',
        }}
        propertySlug={propertySlug}
      />

      {/* WHO TO CALL AND HOW TO PAY THEM, which is what an address book is for.
          Rendered only where there is something to show — an empty row of dashes
          teaches nothing. */}
      <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        {supplier.contact_name ? (
          <Fact label="Contact" value={supplier.contact_name} />
        ) : null}
        {supplier.phone ? <Fact label="Phone" value={supplier.phone} /> : null}
        {supplier.email ? <Fact label="Email" value={supplier.email} /> : null}
        {supplier.tax_id ? <Fact label="TIN" value={supplier.tax_id} /> : null}
        {supplier.bank_name ? (
          <Fact
            label="Bank"
            value={[supplier.bank_name, supplier.bank_account_number]
              .filter(Boolean)
              .join(' · ')}
          />
        ) : null}
      </dl>

      {error ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal">
          {error}
        </p>
      ) : loading ? (
        <p className="py-6 text-center text-sm text-charcoal-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-charcoal-muted">
          {NO_ACTIVITY_YET}
        </p>
      ) : (
        <>
          <SupplierActivityTable rows={rows} currency={currency} />
          {/* THE CAP IS ANNOUNCED AND THERE IS A WAY THROUGH (rule 1b). This
              panel is a summary beside an address book, not the list surface —
              the list surface is Purchases, filtered to this supplier, with real
              paging. Saying so out loud is what separates a summary from a
              screen that quietly ends. */}
          <p className="text-sm text-charcoal-muted">
            {count > rows.length
              ? `Showing the ${rows.length} most recent of ${count} orders. `
              : `${count} order${count === 1 ? '' : 's'} in total. `}
            <Link
              to={`/admin/${propertySlug}/purchases?supplier=${supplier.id}`}
              className="font-semibold text-primary underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
            >
              See them all in Purchases
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

// EXTRACTED RATHER THAN COPIED (rule 22): the render proof drives THIS, the
// component the screen runs. A proof against a copy of this markup would prove
// the copy — and the copy is the thing that stops being edited.
export function SupplierActivityTable({
  rows,
  currency,
}: {
  rows: SupplierActivityRow[];
  currency: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[46rem] text-sm">
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            <th className="py-2 pr-3">Order</th>
            <th className="py-2 pr-3">Raised</th>
            <th className="py-2 pr-3">Expected</th>
            <th className="py-2 pr-3">Status</th>
            <th className="py-2 pr-3 text-right">Ordered</th>
            <th className="py-2 pr-3 text-right">Arrived</th>
            <th className="py-2 text-right">Outstanding</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.purchase_order_id}
              className="border-b border-sand-border/60 last:border-0"
            >
              <td className="py-2 pr-3 font-medium text-charcoal">
                {row.order_number}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {formatDisplayDate(row.order_date)}
              </td>
              <td className="py-2 pr-3 text-charcoal-muted">
                {row.expected_date ? formatDisplayDate(row.expected_date) : '—'}
                {/* A LIVE CONSEQUENCE, not teaching (rule 25): it appears
                    only when the promised date has passed with something
                    still outstanding, and it is the row's whole point. */}
                {row.is_late ? (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-900">
                    Late
                  </span>
                ) : null}
              </td>
              <td className="py-2 pr-3">
                <span
                  className={`rounded-full px-2 py-0.5 text-xs font-semibold ${purchaseStatusTone(row.status)}`}
                >
                  {purchaseStatusLabel(row.status)}
                </span>
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatMoney(row.ordered_value, currency)}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums text-charcoal">
                {formatMoney(row.received_value, currency)}
              </td>
              <td className="py-2 text-right tabular-nums text-charcoal">
                {formatMoney(row.outstanding_value, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex gap-2">
      <dt className="text-charcoal-muted">{label}</dt>
      <dd className="font-medium text-charcoal">{value}</dd>
    </div>
  );
}
