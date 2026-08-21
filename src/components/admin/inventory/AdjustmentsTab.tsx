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
import { ReceiveStockForm } from './ReceiveStockForm';
import { StockEntryForm } from './StockEntryForm';
import { WriteOffForm } from './WriteOffForm';

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
  // WHICH FORM IS OPEN, as one value rather than three booleans. Three booleans
  // can all be true, and the state that says "receiving and writing off at once"
  // is one nobody meant and somebody would eventually reach.
  const [openForm, setOpenForm] = useState<'receive' | 'writeoff' | 'adjust' | null>(
    null,
  );
  const [formLocationId, setFormLocationId] = useState(
    locationId ?? locations[0]?.id ?? '',
  );
  const [refreshToken, setRefreshToken] = useState(0);

  const formLocation = locations.find((l) => l.id === formLocationId) ?? null;

  const close = () => setOpenForm(null);
  const posted = async () => {
    setOpenForm(null);
    setRefreshToken((n) => n + 1);
    await onPosted();
  };

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
            /* THREE ACTIONS, AND THEY ARE THREE DIFFERENT THINGS (§9). Receiving
               is stock arriving from outside; a write-off is stock that is gone
               and why; an adjustment is the count having been wrong. Naming them
               apart on the button is the first place that distinction is made —
               a single "record a movement" menu would push the choice into a
               dropdown where the wrong one is one row away. */
            !openForm ? (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setOpenForm('receive')}
                  disabled={locations.length === 0 || items.length === 0}
                  className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <PlusIcon className="h-4 w-4" />
                  Receive stock
                </button>
                <button
                  type="button"
                  onClick={() => setOpenForm('writeoff')}
                  disabled={locations.length === 0 || items.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Write off
                </button>
                <button
                  type="button"
                  onClick={() => setOpenForm('adjust')}
                  disabled={locations.length === 0 || items.length === 0}
                  className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Adjust
                </button>
              </div>
            ) : null
          }
        />

        {/* THE RECEIVE AND WRITE-OFF FORMS CHOOSE THEIR OWN LOCATION, because a
            delivery goes into a specific store and a loss happened in a specific
            place — neither inherits the page's scope. The ADJUSTMENT form still
            takes the shared picker above it, which is how it has always worked. */}
        {openForm === 'receive' ? (
          <div className="mt-4">
            <ReceiveStockForm
              tenantId={tenantId}
              propertyId={propertyId}
              currency={currency}
              timezone={timezone}
              defaultLocationId={locationId}
              locations={locations}
              onDone={posted}
              onCancel={close}
            />
          </div>
        ) : null}

        {openForm === 'writeoff' ? (
          <div className="mt-4">
            <WriteOffForm
              tenantId={tenantId}
              propertyId={propertyId}
              currency={currency}
              timezone={timezone}
              defaultLocationId={locationId}
              locations={locations}
              onDone={posted}
              onCancel={close}
            />
          </div>
        ) : null}

        {openForm === 'adjust' ? (
          <div className="mt-4 space-y-4">
            <div className="sm:max-w-xs">
              {/* Searchable, server-side (rule 26). */}
              <LocationPicker
                tenantId={tenantId}
                propertyId={propertyId}
                label="Which location"
                value={formLocationId}
                onChange={setFormLocationId}
                selectedLocation={formLocation}
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
                onDone={posted}
                onCancel={close}
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
