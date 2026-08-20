import { useState } from 'react';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { PlusIcon } from '../../ui/icons';
import {
  ADJUSTMENTS_ABOUT,
  ADJUSTMENTS_ABOUT_TITLE,
} from '../../../lib/stockLabels';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import { MovementsList } from './MovementsList';
import { LocationPicker } from './LocationPicker';
import { StockEntryForm } from './StockEntryForm';

// THE ADJUSTMENTS TAB — every correction ever posted, and the form that posts
// one. The ERP has the same pair on the same tab, and for the same reason: the
// person about to write stock off should be looking at the last twenty write-offs
// while they do it.
//
// AN ADJUSTMENT IS THE MOST SENSITIVE WRITE IN THIS MODULE. It changes stock with
// no purchase and no sale behind it, which is the classic shape of a covered
// theft. 036 §4.2 enforces the three things that matter server-side — a reason is
// mandatory, the actor is stamped from the session and cannot be forged, and the
// row can never afterwards be edited or deleted. This screen states all three in
// words before anyone posts, rather than letting them be discovered as validation
// errors.
//
// The list defaults to EVERY location, not the one selected above, deliberately:
// an owner scanning corrections wants the hotel's whole picture, and narrowing to
// one store is one click away.
//
// Both of those facts USED TO BE PARAGRAPHS AT THE TOP OF THE SCREEN. They are in
// the ⓘ now (rule 25) and in the staff guide under "Adding or correcting stock":
// the person who opens this tab has a shelf that is wrong and wants the button.

interface AdjustmentsTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  locations: StockLocation[];
  items: InventoryItem[];
  // The location the page is scoped to, used only to preselect the form's.
  locationId: string | null;
  onPosted: () => Promise<void> | void;
}

export function AdjustmentsTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  locations,
  items,
  locationId,
  onPosted,
}: AdjustmentsTabProps) {
  const [formOpen, setFormOpen] = useState(false);
  const [formLocationId, setFormLocationId] = useState(
    locationId ?? locations[0]?.id ?? '',
  );
  const [refreshToken, setRefreshToken] = useState(0);

  const formLocation = locations.find((l) => l.id === formLocationId) ?? null;

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <ScreenHeader
          level={2}
          title="Adjustments"
          purpose="Correct a quantity that is wrong, with a reason on the record."
          about={{
            title: ADJUSTMENTS_ABOUT_TITLE,
            paragraphs: ADJUSTMENTS_ABOUT,
            guideAnchor: 'adding-or-correcting-stock',
            guideLabel: 'Adding or correcting stock',
          }}
          propertySlug={propertySlug}
          actions={
            !formOpen ? (
              <button
                type="button"
                onClick={() => setFormOpen(true)}
                disabled={locations.length === 0 || items.length === 0}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                <PlusIcon className="h-4 w-4" />
                New adjustment
              </button>
            ) : null
          }
        />

        {formOpen ? (
          <div className="mt-4 space-y-4">
            <div className="sm:max-w-xs">
              {/* Searchable, server-side (rule 26) — see LocationPicker on why a
                  four-row list gets a typeahead anyway. */}
              <LocationPicker
                tenantId={tenantId}
                propertyId={propertyId}
                label="Which location"
                value={formLocationId}
                onChange={setFormLocationId}
                selectedLocation={formLocation}
                // A correction writes a movement, so only a location in use.
                activeOnly
                required
              />
            </div>
            {formLocation ? (
              <StockEntryForm
                tenantId={tenantId}
                propertyId={propertyId}
                locationId={formLocation.id}
                locationName={formLocation.name}
                currency={currency}
                timezone={timezone}
                items={items}
                presetMode="adjustment"
                onDone={async () => {
                  setFormOpen(false);
                  setRefreshToken((n) => n + 1);
                  await onPosted();
                }}
                onCancel={() => setFormOpen(false)}
              />
            ) : (
              <p className="text-sm text-charcoal-muted">
                This hotel has no stock locations yet. Add one under “Manage
                locations” before recording a correction.
              </p>
            )}
          </div>
        ) : null}
      </div>

      <MovementsList
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        timezone={timezone}
        movementType="adjustment"
        locations={locations}
        items={items}
        emptyTitle="No adjustments recorded yet"
        emptyBody="Corrections appear here as soon as one is posted — what changed, where, why, and in whose name."
        refreshToken={refreshToken}
      />
    </div>
  );
}
