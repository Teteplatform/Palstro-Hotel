import { useState } from 'react';
import { Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { PlusIcon } from '../../ui/icons';
import { ADJUSTMENT_REASON_EXPLANATION } from '../../../lib/stockLabels';
import type { InventoryItem, StockLocation } from '../../../types/inventory';
import { MovementsList } from './MovementsList';
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

interface AdjustmentsTabProps {
  tenantId: string;
  propertyId: string;
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

  const locationOptions: SelectOption[] = locations.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-charcoal">Adjustments</h2>
            <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
              {ADJUSTMENT_REASON_EXPLANATION}
            </p>
          </div>
          {!formOpen ? (
            <button
              type="button"
              onClick={() => setFormOpen(true)}
              disabled={locations.length === 0 || items.length === 0}
              className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              <PlusIcon className="h-4 w-4" />
              New adjustment
            </button>
          ) : null}
        </div>

        {formOpen ? (
          <div className="mt-4 space-y-4">
            <div className="sm:max-w-xs">
              <Select
                label="Which location"
                required
                value={formLocationId}
                onChange={setFormLocationId}
                options={locationOptions}
                helpText="Stock is physical — a correction belongs to one place."
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
