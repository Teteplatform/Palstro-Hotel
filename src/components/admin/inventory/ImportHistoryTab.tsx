import { Link } from 'react-router-dom';
import { ScreenHeader } from '../../ui/ScreenHeader';
import {
  IMPORT_HISTORY_ABOUT,
  IMPORT_HISTORY_ABOUT_TITLE,
} from '../../../lib/stockLabels';
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
        <ScreenHeader
          level={2}
          title="Opening stock"
          purpose="Every opening balance on file, newest first."
          about={{
            title: IMPORT_HISTORY_ABOUT_TITLE,
            paragraphs: IMPORT_HISTORY_ABOUT,
            guideAnchor: 'loading-your-opening-stock-from-a-spreadsheet',
            guideLabel: 'Loading your opening stock',
          }}
          propertySlug={propertySlug}
          actions={
            <Link
              to={`/admin/${propertySlug}/stock/import`}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Load from a spreadsheet
            </Link>
          }
        />
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
