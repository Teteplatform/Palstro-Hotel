import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Select } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { CloseIcon } from '../../ui/icons';
import { INVENTORY_ABOUT, INVENTORY_ABOUT_TITLE } from '../../../lib/stockLabels';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useLocations } from '../../../hooks/useLocations';
import { useInventoryReference } from '../../../hooks/useInventoryReference';
import { describeError } from '../../../lib/errors';
import { fetchAllInventoryItems } from '../../../lib/inventory';
import type { InventoryItem } from '../../../types/inventory';
import { INVENTORY_TABS, type InventoryTabKey } from './inventoryTabs';
import { AdjustmentsTab } from './AdjustmentsTab';
import { CategoriesPanel } from './CategoriesPanel';
import { ComingSoonPanel } from './ComingSoonPanel';
import { ImportHistoryTab } from './ImportHistoryTab';
import { LocationsScreen } from './LocationsScreen';
import { ProductsTab } from './ProductsTab';
import { NegativeStockTab } from './NegativeStockTab';
import { StockTakeTab } from './StockTakeTab';

// THE CONSOLIDATED INVENTORY SCREEN — one page for the whole module, modelled on
// the ERP's Products page because that layout is proven on a working business
// and this hotel's owner already reads it fluently.
//
// WHAT IT REPLACED, AND WHY. Until now the module was three separate screens:
// Items (the tenant catalogue, no quantities), Locations (the boxes that hold
// stock) and Store (one location's quantities). Every real job crossed at least
// two of them — adding an item and then recording what is on its shelf meant two
// screens and two mental models, and the second half was the half people forgot.
// This is those three, in one place, with the location as a control on the page
// rather than as a screen you navigate to.
//
// THE LOCATION SELECTOR IS THE PAGE'S PRIMARY CONTROL, not a filter. Stock is
// physical (036 §1): 200 kg of rice in the Main Store and 15 kg in the Kitchen
// are separate quantities with separate valuations. "All locations" is a
// deliberate roll-up across them, and the Products table shows the breakdown so
// the roll-up is never mistaken for one pile.
//
// PER-ROLE LOCATION ACCESS IS NOT BUILT AND IS NOT PRETENDED. The selector shows
// every location in the property to whoever can reach this page. Restricting a
// barman to the Bar needs the staff and roles layer — who a person is, which
// locations they operate — and that does not exist yet. RLS still guards the data
// by tenant (rule 19), and every query on this page is additionally scoped to the
// active tenant AND property; what is missing is the finer, per-user cut, and it
// arrives with staff.
//
// MANAGING LOCATIONS IS AN ACTION, NOT A TAB. Naming your stores is setup work
// done once and revisited rarely — a tab would give it the same weight as the
// stock itself. It opens the same editor the standalone screen used, so nothing
// about it changed except where it is reached from.

interface InventoryScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
}

export function InventoryScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
}: InventoryScreenProps) {
  const locations = useLocations(propertyId, tenantId);
  const reference = useInventoryReference(tenantId);

  // THE ACTIVE TAB LIVES IN THE URL, so it can be linked to and come back to.
  // It became necessary the moment a stock count moved to its own page: "back
  // to counts" has to land on the Stock Take tab, and a tab held only in
  // component state would drop the user on Products every time. The same
  // convention the settings screen already uses.
  //
  // An unknown or absent tab falls back to the first one rather than rendering
  // nothing — a mistyped URL should open the page, not break it.
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTab = searchParams.get('tab') as InventoryTabKey | null;
  const activeTab: InventoryTabKey =
    requestedTab && INVENTORY_TABS.some((t) => t.key === requestedTab)
      ? requestedTab
      : 'products';

  const setActiveTab = useCallback(
    (key: InventoryTabKey) => {
      // replace, not push: a tab is a view of one page, and pushing would make
      // the browser's Back button walk the tab strip instead of leaving.
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('tab', key);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  // '' is All locations — the roll-up across the property, and the default,
  // because "what does this hotel hold?" is the question the page opens on.
  // Not stored anywhere (no browser storage, by constraint): a fresh visit
  // starts at the whole property.
  const [locationId, setLocationId] = useState('');
  const [managingLocations, setManagingLocations] = useState(false);

  // The whole ACTIVE catalogue, loaded once here and shared by every tab that
  // needs an item picker (the stock entry form, the movement filters). Loading
  // it per tab would refetch three hundred items on every tab change.
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [itemsError, setItemsError] = useState<string | null>(null);
  const [catalogueNonce, setCatalogueNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchAllInventoryItems(tenantId, true);
        if (!cancelled) {
          setItems(rows);
          setItemsError(null);
        }
      } catch (e) {
        // Rule 11: surfaced, never swallowed. The page still works — the pickers
        // just cannot be populated, and each tab says so where it matters.
        if (!cancelled) setItemsError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, catalogueNonce]);

  const reloadCatalogue = useCallback(() => {
    setCatalogueNonce((n) => n + 1);
  }, []);

  const locationOptions: SelectOption[] = [
    { value: '', label: 'All locations' },
    ...locations.rows.map((l) => ({
      value: l.id,
      label: l.is_active ? l.name : `${l.name} (closed)`,
    })),
  ];

  const scopedLocationId = locationId || null;
  const tab = INVENTORY_TABS.find((t) => t.key === activeTab) ?? INVENTORY_TABS[0];

  return (
    <div className="mx-auto max-w-6xl">
      {/* ONE LINE OF PURPOSE, then the controls (rule 25). The second half of
          the old paragraph — that every figure is folded from the movements and
          nothing is stored — is true, load-bearing and of no use to somebody
          about to correct a shelf, so it is in the ⓘ and in the guide. */}
      <ScreenHeader
        className="mb-5"
        title="Inventory"
        purpose="What you hold, where it is, and what it is worth."
        about={{
          title: INVENTORY_ABOUT_TITLE,
          paragraphs: INVENTORY_ABOUT,
          guideAnchor: 'what-the-stock-figures-mean',
          guideLabel: 'What the stock figures mean',
        }}
        propertySlug={propertySlug}
      />

      {locations.error ? (
        <div className="mb-4 rounded-2xl border border-sand-border bg-white/60 p-4">
          <p className="text-sm font-medium text-charcoal">
            We couldn’t load your stock locations.
          </p>
          <p className="mt-1 text-sm text-charcoal-muted">
            {locations.error.message}
          </p>
          <button
            type="button"
            onClick={() => void locations.reload()}
            className="mt-3 rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Try again
          </button>
        </div>
      ) : null}

      {reference.error ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          Units and categories could not load, so adding and editing items is
          unavailable: {reference.error.message}
        </p>
      ) : null}

      {/* The location selector, with managing them beside it rather than in the
          tab row. */}
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1 sm:max-w-xs">
          <Select
            label="View stock at"
            value={locationId}
            onChange={setLocationId}
            options={locationOptions}
            disabled={locations.loading}
          />
        </div>
        <button
          type="button"
          onClick={() => setManagingLocations(true)}
          className="rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Manage locations
        </button>
        {/* THE OPENING-STOCK IMPORT, DEMOTED ON PURPOSE. It used to sit in the
            Products action row next to Add product, labelled "Import", and that
            is precisely what taught people that adding a product meant
            uploading a stock sheet — two different jobs, one button apart.
            Here it reads as what it is: a page-level setup action, done ONCE
            per location, AFTER the items exist. Beside Manage locations because
            they are the same kind of thing — the setup you do on day one and
            rarely touch again. */}
        <Link
          to={`/admin/${propertySlug}/stock/import`}
          className="rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          Load opening stock
        </Link>
      </div>

      {locations.rows.length === 0 && !locations.loading ? (
        <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          This hotel has no stock locations yet. Stock is held in a place — a
          store, a kitchen, a bar — so add at least one under “Manage locations”
          before recording any.
        </p>
      ) : null}

      {/* The tab row. Horizontally scrollable rather than wrapped, so the strip
          reads as one row of tabs at 360px instead of a block of buttons. */}
      <div
        className="-mx-4 mb-4 overflow-x-auto border-b border-sand-border px-4 sm:mx-0 sm:px-0"
        role="tablist"
        aria-label="Inventory sections"
      >
        <div className="flex min-w-max gap-1">
          {INVENTORY_TABS.map((t) => {
            const active = t.key === activeTab;
            return (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.key)}
                className={`-mb-px flex-shrink-0 whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                  active
                    ? 'border-primary text-primary'
                    : 'border-transparent text-charcoal-muted hover:text-charcoal'
                }`}
              >
                {t.label}
                {t.status === 'soon' ? (
                  <span className="ml-1.5 rounded-full bg-sand px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                    soon
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      </div>

      <div role="tabpanel">
        {activeTab === 'products' ? (
          <ProductsTab
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={propertySlug}
            currency={currency}
            timezone={timezone}
            locationId={scopedLocationId}
            locations={locations.rows}
            units={reference.units}
            categories={reference.categories}
            referenceLoading={reference.loading}
            items={items}
            itemsError={itemsError}
            onCatalogueChanged={reloadCatalogue}
            // A unit or category added inline from the item form has to reach
            // every other picker on this page, not just the form it was typed
            // into — the filter bar and the categories tab read the same list.
            onReferenceChanged={reference.reload}
          />
        ) : null}

        {activeTab === 'categories' ? (
          <CategoriesPanel
            tenantId={tenantId}
            categories={reference.categories}
            onChanged={() => void reference.reload()}
            alwaysOpen
          />
        ) : null}

        {activeTab === 'adjustments' ? (
          <AdjustmentsTab
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={propertySlug}
            currency={currency}
            timezone={timezone}
            locations={locations.rows}
            items={items}
            locationId={scopedLocationId}
            onPosted={reloadCatalogue}
          />
        ) : null}

        {activeTab === 'stock_take' ? (
          <StockTakeTab
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={propertySlug}
            currency={currency}
            timezone={timezone}
            locations={locations.rows}
            locationId={scopedLocationId}
            onPosted={reloadCatalogue}
          />
        ) : null}

        {activeTab === 'negative_stock' ? (
          <NegativeStockTab
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={propertySlug}
            currency={currency}
            timezone={timezone}
            locations={locations.rows}
            categories={reference.categories}
          />
        ) : null}

        {activeTab === 'import_history' ? (
          <ImportHistoryTab
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={propertySlug}
            currency={currency}
            timezone={timezone}
            locations={locations.rows}
            items={items}
          />
        ) : null}

        {tab.status === 'soon' ? (
          <ComingSoonPanel
            title={tab.label}
            summary={tab.soonSummary ?? ''}
            detail={tab.soonDetail ?? ''}
            propertySlug={propertySlug}
            needs={tab.soonNeeds}
            meanwhile={tab.soonMeanwhile}
          />
        ) : null}
      </div>

      {managingLocations ? (
        <ManageLocationsPanel
          tenantId={tenantId}
          propertyId={propertyId}
          onClose={() => {
            setManagingLocations(false);
            // A renamed, added or removed location changes the selector and
            // every breakdown on the page.
            void locations.reload();
          }}
        />
      ) : null}
    </div>
  );
}

// The locations editor, as a panel over the page. It is the SAME component the
// standalone screen used — moving where something is reached from must not fork
// what it does, or the two copies drift and only one gets the next fix.
function ManageLocationsPanel({
  tenantId,
  propertyId,
  onClose,
}: {
  tenantId: string;
  propertyId: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div className="absolute inset-0 bg-charcoal/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Manage stock locations"
        className="relative flex h-full w-full max-w-2xl flex-col bg-cream shadow-2xl"
      >
        <header className="flex flex-none items-center justify-between gap-3 border-b border-sand-border px-4 py-4 sm:px-6">
          <h2 className="text-base font-semibold text-charcoal">
            Manage stock locations
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          <LocationsScreen propertyId={propertyId} tenantId={tenantId} embedded />
        </div>
      </div>
    </div>
  );
}
