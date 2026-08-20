import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ActionMenu, type ActionMenuItem } from '../../ui/ActionMenu';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { useToast } from '../../ui/Toast';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError, humanizeError } from '../../../lib/errors';
import { formatMoney, MISSING_VALUE } from '../../../lib/format';
import { itemTypeLabel, itemTypeTone } from '../../../lib/inventoryLabels';
import { softDeleteInventoryItem } from '../../../lib/inventory';
import { mediaVariantUrl } from '../../../lib/mediaUrl';
import { fetchItemImages } from '../../../lib/itemImages';
import {
  fetchItemMovements,
  fetchItemPositionAtScope,
  summariseByType,
  unaccountedQuantity,
  type ItemMovement,
  type ItemPosition,
  type MovementTypeTotal,
} from '../../../lib/itemDetail';
import { ITEM_PAGE_ABOUT, ITEM_PAGE_ABOUT_TITLE } from '../../../lib/stockLabels';
import type {
  InventoryCategory,
  InventoryItem,
  StockLocation,
  UnitOfMeasure,
} from '../../../types/inventory';
import type { MovementType } from '../../../types/stock';
import { ItemMovementCards } from './ItemMovementCards';
import { ItemMovementLedger } from './ItemMovementLedger';
import { ItemPanel } from './ItemPanel';
import { LocationPicker } from './LocationPicker';
import { StockEntryForm } from './StockEntryForm';
import { StockLevelChart } from './StockLevelChart';

// ONE ITEM, ON ITS OWN PAGE (1.1f).
//
// ---------------------------------------------------------------------------
// THE SAME MOVE THE COUNT PAGE MADE, FOR THE SAME REASON
// ---------------------------------------------------------------------------
// An item used to be an expanding row inside a paginated table inside a tab strip:
// its ledger opened in a panel three levels deep, and everything around it was
// about a hundred other items. Looking into one item — where did the 40 kg go,
// why is the average what it is — is a job somebody does for ten minutes, and a
// tab strip above it is an invitation to lose the place by clicking something.
//
// So it is a route, and deliberately a SIBLING of the count page rather than a
// stranger: the same shell, the same real <Link> back rather than browser history
// (this page is deep-linkable, so "back" must mean somewhere), the same
// cancelled-flag fetch, and the same keying by property so switching hotel
// remounts instead of showing one property's stock under another's name.
//
// ---------------------------------------------------------------------------
// THE PAGE CARRIES ITS OWN LOCATION SCOPE, AND IT HAS TO
// ---------------------------------------------------------------------------
// The catalogue is tenant-wide and stock is per location (035/036). So "how much
// Rice is there" has no answer until somebody says WHERE, and a page that
// inherited the list's location silently would show a figure for one shelf under
// a heading about an item — which is exactly how a store total gets read as a
// kitchen total. The scope is a control ON THIS PAGE, it is in the URL so the page
// can be linked to at a scope, and every card, the chart and the ledger follow it.
//
// It defaults to whatever the list was showing, because arriving somewhere and
// having the number change under you is worse than either scope.

interface ItemDetailScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  item: InventoryItem;
  locations: StockLocation[];
  // The scope, from the URL. NULL = every location in this property.
  locationId: string | null;
  onScopeChange: (locationId: string | null) => void;
  // Re-read the item row after an edit or a new picture, so the header is the
  // server's version rather than this screen's guess at it.
  onItemChanged: () => Promise<void> | void;
  // Everything the edit panel needs, loaded once by the page. Named types rather
  // than `Parameters<typeof ItemPanel>[0]['units']` — the indexed form works, and
  // it makes a reader open another file to learn that a unit is a unit.
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  referenceLoading: boolean;
}

export function ItemDetailScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  item,
  locations,
  locationId,
  onScopeChange,
  onItemChanged,
  units,
  categories,
  referenceLoading,
}: ItemDetailScreenProps) {
  const toast = useToast();
  const navigate = useNavigate();

  const [movements, setMovements] = useState<ItemMovement[]>([]);
  const [position, setPosition] = useState<ItemPosition | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // The card filter. NULL = showing everything. One at a time (see the cards).
  const [selectedType, setSelectedType] = useState<MovementType | null>(null);
  // A movement the chart asked the ledger to show. Cleared once the ledger has
  // scrolled to it, so re-clicking the same point works a second time.
  const [highlighted, setHighlighted] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const [imageUrl, setImageUrl] = useState<string | null>(null);

  const ledgerRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    setNonce((n) => n + 1);
  }, []);

  // The page's data, at the scope. The codebase's fetch shape: an IIFE inside the
  // effect with a `cancelled` flag, so a scope change or a fast navigation cannot
  // land a stale response on a page that has moved on.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [rows, pos] = await Promise.all([
          fetchItemMovements(tenantId, propertyId, item.id, locationId),
          fetchItemPositionAtScope(tenantId, propertyId, item.id, locationId),
        ]);
        if (cancelled) return;
        setMovements(rows);
        setPosition(pos);
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
  }, [tenantId, propertyId, item.id, locationId, nonce]);

  // The picture. Its own effect because it changes on a different schedule from
  // the stock — uploading one must not re-pull a thousand movements.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!item.image_asset_id) {
        if (!cancelled) setImageUrl(null);
        return;
      }
      try {
        const map = await fetchItemImages(tenantId, [item.image_asset_id]);
        if (cancelled) return;
        const asset = map.get(item.image_asset_id);
        // 'card' and never 'full': a 112px header tile pulling the 1920px file is
        // wasted egress on every page open.
        setImageUrl(asset ? mediaVariantUrl(asset.bucket_path, 'card') : null);
      } catch {
        // A picture that will not load is shown as no picture. It is decoration
        // here; failing the whole page over it would be the wrong trade, and the
        // stock figures below are what somebody came for.
        if (!cancelled) setImageUrl(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, item.image_asset_id]);

  const scopeLocation = locations.find((l) => l.id === locationId) ?? null;
  const scopeName = scopeLocation?.name ?? 'Every location';

  const totals: MovementTypeTotal[] = summariseByType(movements);
  const unaccounted = unaccountedQuantity(movements);

  // The ledger's rows, filtered by the card selection. The CARDS never filter —
  // they always describe the whole scope, so pressing one cannot change the
  // figures it is being checked against. That is §2's promise: the totals do not
  // move when the ledger does.
  const ledgerRows = selectedType
    ? movements.filter((m) => m.movement_type === selectedType)
    : movements;

  // A movement the chart pointed at, when the card filter is hiding it, is a dead
  // click. Clearing the filter is the right answer rather than ignoring the click:
  // the person asked to see that row.
  const showMovement = useCallback(
    (movementId: string) => {
      const target = movements.find((m) => m.id === movementId);
      if (target && selectedType && target.movement_type !== selectedType) {
        setSelectedType(null);
      }
      setHighlighted(movementId);
      ledgerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    [movements, selectedType],
  );

  async function handleRemove() {
    if (
      !window.confirm(
        `Remove "${item.name}"? It leaves the catalogue, but its history is kept and it can be added again later. An item still holding stock anywhere cannot be removed.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await softDeleteInventoryItem(item.id, tenantId);
      toast.success('Item removed.');
      // Back to the list: this page is about an item that no longer exists.
      navigate(backHref);
    } catch (e) {
      // 036 §6 refuses this at the DATABASE when the item still holds stock, and
      // says so in a sentence the user can act on.
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  // A REAL LINK, not history (the count page's note): this page is deep-linkable,
  // so "back" has to mean somewhere rather than wherever the person came from. The
  // scope rides along, so returning lands on the list showing the same location.
  const backHref = `/admin/${propertySlug}/inventory${
    locationId ? `?location=${locationId}` : ''
  }`;

  const menu: ActionMenuItem[] = [
    {
      key: 'edit',
      label: 'Edit item',
      hint: 'Its name, type, unit, price and picture. Applies everywhere it is used.',
      onSelect: () => setEditing(true),
    },
    {
      key: 'adjust',
      label: 'Add or correct stock',
      hint: scopeLocation
        ? `Post a movement against ${scopeLocation.name}.`
        : 'Pick a location above first — stock is always in one place.',
      disabled: !scopeLocation,
      onSelect: () => setEntryOpen(true),
    },
    {
      key: 'remove',
      label: 'Remove item',
      hint: 'Leaves the catalogue, keeps its history. Refused while it holds stock.',
      tone: 'danger',
      onSelect: () => void handleRemove(),
    },
  ];

  return (
    <div className="space-y-4">
      <Link
        to={backHref}
        className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none print:hidden"
      >
        <ArrowLeftIcon className="h-4 w-4" />
        All products
      </Link>

      {/* THE HEADER: the picture, what the thing IS, and the kebab. One line of
          purpose (rule 25); everything about how the figures work is behind the ⓘ
          and in the guide. */}
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="h-20 w-20 flex-shrink-0 overflow-hidden rounded-xl border border-sand-border bg-sand/60">
            {imageUrl ? (
              <img src={imageUrl} alt="" aria-hidden="true" className="h-full w-full object-cover" />
            ) : null}
          </div>

          <div className="min-w-0 flex-1">
            <ScreenHeader
              title={item.name}
              purpose="Everything that has moved this item, and what it adds up to."
              about={{
                title: ITEM_PAGE_ABOUT_TITLE,
                paragraphs: ITEM_PAGE_ABOUT,
                guideAnchor: 'one-item-in-detail',
                guideLabel: 'One item in detail',
              }}
              propertySlug={propertySlug}
              actions={<ActionMenu label={`Actions for ${item.name}`} items={menu} />}
            />

            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-charcoal-muted">
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide uppercase ${itemTypeTone(
                  item.item_type,
                )}`}
              >
                {itemTypeLabel(item.item_type)}
              </span>
              {item.code ? <span>Code {item.code}</span> : null}
              <span>Tracked in {item.base_unit}</span>
              <span>
                Sells for{' '}
                {item.default_selling_price === null
                  ? MISSING_VALUE
                  : `${formatMoney(item.default_selling_price, currency)} per ${item.base_unit}`}
              </span>
              {!item.is_active ? <span className="font-semibold">Not in use</span> : null}
            </div>
          </div>
        </div>

        {/* THE SCOPE. Searchable (rule 26) and clearable, where clearing it means
            every location — the roll-up, the same word the list uses. */}
        <div className="mt-4 sm:max-w-xs">
          <LocationPicker
            tenantId={tenantId}
            propertyId={propertyId}
            label="Stock at"
            value={locationId ?? ''}
            onChange={(v) => onScopeChange(v || null)}
            selectedLocation={scopeLocation}
            clearable
            placeholder="Every location"
          />
        </div>
      </div>

      {error ? (
        <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
          <p className="text-sm font-medium text-charcoal">
            This item’s movements could not be loaded.
          </p>
          <p className="mt-1 text-sm text-charcoal-muted">{error}</p>
          <button
            type="button"
            onClick={() => void reload()}
            className="mt-4 inline-flex items-center rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
          >
            Try again
          </button>
        </div>
      ) : (
        <>
          <ItemMovementCards
            totals={totals}
            position={position}
            baseUnit={item.base_unit}
            currency={currency}
            unaccounted={unaccounted}
            selected={selectedType}
            onSelect={setSelectedType}
            loading={loading}
          />

          {entryOpen && scopeLocation ? (
            <StockEntryForm
              tenantId={tenantId}
              propertyId={propertyId}
              locationId={scopeLocation.id}
              locationName={scopeLocation.name}
              currency={currency}
              timezone={timezone}
              items={[item]}
              presetItemId={item.id}
              presetMode="adjustment"
              onDone={async () => {
                setEntryOpen(false);
                await reload();
              }}
              onCancel={() => setEntryOpen(false)}
            />
          ) : null}

          <StockLevelChart
            movements={movements}
            baseUnit={item.base_unit}
            scopeName={scopeName}
            onSelectMovement={showMovement}
          />

          <div ref={ledgerRef}>
            <ItemMovementLedger
              movements={ledgerRows}
              allMovements={movements}
              baseUnit={item.base_unit}
              currency={currency}
              itemName={item.name}
              locations={locations}
              scopeLocation={scopeLocation}
              selectedType={selectedType}
              onClearFilter={() => setSelectedType(null)}
              highlighted={highlighted}
              onHighlightShown={() => setHighlighted(null)}
              loading={loading}
              onReversed={reload}
            />
          </div>
        </>
      )}

      {editing ? (
        <ItemPanel
          tenantId={tenantId}
          propertyId={propertyId}
          item={item}
          units={units}
          categories={categories}
          locations={locations}
          referenceLoading={referenceLoading}
          currency={currency}
          timezone={timezone}
          defaultLocationId={locationId}
          onReferenceChanged={onItemChanged}
          onSaved={async () => {
            await onItemChanged();
            await reload();
          }}
          onClose={() => setEditing(false)}
        />
      ) : null}

      {busy ? <span className="sr-only" aria-live="polite">Working…</span> : null}
    </div>
  );
}
