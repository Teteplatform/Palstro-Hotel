import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { PlusIcon } from '../../ui/icons';
import { useLocations } from '../../../hooks/useLocations';
import { humanizeError } from '../../../lib/errors';
import {
  createLocation,
  softDeleteLocation,
  updateLocation,
} from '../../../lib/inventory';
import {
  LOCATION_KINDS,
  locationKindHint,
  locationKindLabel,
  locationKindTone,
} from '../../../lib/inventoryLabels';
import type { LocationKind, StockLocation } from '../../../types/inventory';
import { LocationCard } from './LocationCard';

// The locations admin screen (F&B/Inventory part 1). A location is a BOX THAT
// HOLDS STOCK — the main store, the kitchen, each bar, housekeeping — scoped to
// the ACTIVE PROPERTY, because stock is physical and one hotel's kitchen is not
// another's.
//
// Which locations exist is DATA, not code: a property is seeded with four
// sensible defaults (035 §5) and the hotel renames, adds and removes from there.
// A standalone restaurant keeps Store + Kitchen + a Bar and removes
// Housekeeping. Nothing in this screen — or in any later part — may assume a
// particular location exists, or that there is only one of a kind: two bars are
// normal, each with its own stock and its own variance.
//
// The list is loaded COMPLETE rather than paged (see useLocations): it is a
// handful of rows, nothing is capped or unreachable, and reordering needs the
// whole ordered set in hand.

interface LocationsScreenProps {
  propertyId: string;
  tenantId: string;
  // Rendered inside the inventory page's "Manage locations" panel rather than as
  // a route of its own. The panel supplies the heading and the width, so this
  // drops both — two headings stacked on one dialog reads as a mistake, and a
  // centred max-width inside an already-narrow panel wastes the space.
  embedded?: boolean;
}

export function LocationsScreen({
  propertyId,
  tenantId,
  embedded = false,
}: LocationsScreenProps) {
  const toast = useToast();
  const list = useLocations(propertyId, tenantId);

  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newKind, setNewKind] = useState<LocationKind>('store');
  const [nameError, setNameError] = useState<string | undefined>();

  async function run(work: () => Promise<void>, success?: string) {
    setBusy(true);
    try {
      await work();
      if (success) toast.success(success);
      await list.reload();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleAdd() {
    const name = newName.trim();
    if (!name) {
      setNameError('A location name is required.');
      return;
    }
    await run(async () => {
      // Append past the last one, in tens, so a later manual re-ordering has
      // room between entries.
      const nextOrder =
        list.rows.reduce((max, l) => Math.max(max, l.display_order), 0) + 10;
      await createLocation(tenantId, propertyId, {
        name,
        kind: newKind,
        display_order: nextOrder,
      });
      setNewName('');
      setNewKind('store');
      setNameError(undefined);
      setAdding(false);
    }, 'Location added.');
  }

  async function handleSave(
    location: StockLocation,
    values: { name: string; kind: LocationKind; isActive: boolean },
  ) {
    await run(
      () =>
        updateLocation(location.id, tenantId, propertyId, {
          name: values.name,
          kind: values.kind,
          is_active: values.isActive,
        }).then(() => undefined),
      'Location saved.',
    );
  }

  async function handleMove(index: number, dir: -1 | 1) {
    const j = index + dir;
    if (j < 0 || j >= list.rows.length) return;
    const a = list.rows[index];
    const b = list.rows[j];
    // Swap their display_order values outright. The list is complete, so this
    // index arithmetic covers every row — there is no page boundary to skip.
    await run(async () => {
      await updateLocation(a.id, tenantId, propertyId, {
        display_order: b.display_order,
      });
      await updateLocation(b.id, tenantId, propertyId, {
        display_order: a.display_order,
      });
    });
  }

  async function handleRemove(location: StockLocation) {
    if (
      !window.confirm(
        `Remove "${location.name}"? It leaves this list. Once stock movements exist, a location still holding stock will not be removable at all.`,
      )
    ) {
      return;
    }
    await run(
      () => softDeleteLocation(location.id, tenantId, propertyId),
      'Location removed.',
    );
  }

  const kindOptions: SelectOption[] = LOCATION_KINDS.map((k) => ({
    value: k,
    label: locationKindLabel(k),
  }));

  return (
    <div className={embedded ? undefined : 'mx-auto max-w-3xl'}>
      <header className="mb-6">
        {embedded ? null : (
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Stock locations
          </h1>
        )}
        <p className={embedded ? 'text-sm text-charcoal-muted' : 'mt-1 text-sm text-charcoal-muted'}>
          The places that hold stock in this hotel — your store, the kitchen,
          each bar, housekeeping. Rename them to whatever you call them, and add
          as many as you have: two bars each keep their own stock.
        </p>
      </header>

      {list.error ? (
        <ErrorState
          message={list.error.message}
          onRetry={() => void list.reload()}
        />
      ) : (
        <>
          <div className="mb-4">
            {adding ? (
              <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
                <h2 className="mb-3 text-base font-semibold text-charcoal">
                  New location
                </h2>
                <div className="grid gap-4 sm:grid-cols-2">
                  <TextField
                    label="Name"
                    required
                    value={newName}
                    onChange={(v) => {
                      setNewName(v);
                      setNameError(undefined);
                    }}
                    error={nameError}
                    placeholder="e.g. Poolside Bar"
                    disabled={busy}
                  />
                  <Select
                    label="Kind"
                    required
                    value={newKind}
                    onChange={(v) => setNewKind(v as LocationKind)}
                    options={kindOptions}
                    // The hint follows the choice, so what the kind will DO is
                    // visible at the moment it is picked.
                    helpText={locationKindHint(newKind)}
                    disabled={busy}
                  />
                </div>
                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => void handleAdd()}
                    disabled={busy}
                    className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
                  >
                    {busy ? 'Adding…' : 'Add location'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setAdding(false);
                      setNewName('');
                      setNameError(undefined);
                    }}
                    disabled={busy}
                    className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                <PlusIcon className="h-4 w-4" />
                Add location
              </button>
            )}
          </div>

          {list.loading && list.rows.length === 0 ? (
            <LoadingState />
          ) : list.rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="space-y-3">
              {list.rows.map((location, index) => (
                <li key={location.id}>
                  <LocationCard
                    location={location}
                    kindOptions={kindOptions}
                    busy={busy}
                    isFirst={index === 0}
                    isLast={index === list.rows.length - 1}
                    onSave={(values) => void handleSave(location, values)}
                    onMove={(dir) => void handleMove(index, dir)}
                    onRemove={() => void handleRemove(location)}
                  />
                </li>
              ))}
            </ul>
          )}

          {/* What each kind means, once, below the list — the same words the
              form shows inline, so the page can be read as a reference. */}
          <section className="mt-8 rounded-2xl border border-sand-border bg-white/50 p-4">
            <h2 className="text-sm font-semibold text-charcoal">
              What each kind does
            </h2>
            <dl className="mt-2 space-y-2">
              {LOCATION_KINDS.map((kind) => (
                <div key={kind} className="flex flex-wrap items-baseline gap-2">
                  <dt>
                    <span
                      className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${locationKindTone(kind)}`}
                    >
                      {locationKindLabel(kind)}
                    </span>
                  </dt>
                  <dd className="min-w-0 flex-1 text-xs text-charcoal-muted">
                    {locationKindHint(kind)}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </>
      )}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading locations…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        No stock locations yet
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        Add the places that hold stock here — a main store to receive deliveries
        into is usually the first one.
      </p>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-charcoal">
        We couldn’t load your locations.
      </p>
      <p className="mt-1 text-sm text-charcoal-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        Try again
      </button>
    </div>
  );
}
