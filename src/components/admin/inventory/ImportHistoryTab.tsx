import { Link } from 'react-router-dom';
import { IMPORT_HISTORY_NOTE } from '../../../lib/stockLabels';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import { MovementsList } from './MovementsList';

// IMPORT HISTORY — what the spreadsheet load actually left behind.
//
// THE HONEST SCOPE, stated on the tab itself as well as here. The ERP's Import
// History reads an `import_history` table: one row per file, with its name, its
// row counts and its failures. This system has no such table, and the opening
// balance RPC records its own provenance as 'manual' whatever posted it — so
// there is genuinely nothing to read that would say "this file, these rows,
// these errors".
//
// What DOES exist is the outcome: every opening balance on file, with its
// location, its quantity, its cost, its business date and the person who loaded
// it. That is the question people actually bring to this tab ("did the store's
// opening stock go in, and when?"), so it is answered — and the thing it cannot
// answer says so, rather than being dressed up as a file log.
//
// A per-file record belongs with purchasing (tranche 2c), where receipts and
// supplier documents give it a reason to exist beyond the one day a hotel
// switches the system on.

interface ImportHistoryTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  locations: StockLocation[];
  items: InventoryItem[];
}

export function ImportHistoryTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  locations,
  items,
}: ImportHistoryTabProps) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-charcoal">
              Opening stock loaded
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
              {IMPORT_HISTORY_NOTE}
            </p>
          </div>
          <Link
            to={`/admin/${propertySlug}/stock/import`}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            Load from a spreadsheet
          </Link>
        </div>
      </div>

      <MovementsList
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        timezone={timezone}
        movementType="opening"
        locations={locations}
        items={items}
        emptyTitle="No opening balances recorded yet"
        emptyBody="Nothing has been loaded for this hotel. Start with a spreadsheet for a whole store, or record balances one item at a time as you add products."
        refreshToken={0}
      />
    </div>
  );
}
