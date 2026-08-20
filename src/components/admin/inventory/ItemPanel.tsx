import { useEffect, useRef, useState } from 'react';
import { CurrencyField, DateField, NumberField, TextField } from '../../ui/form';
import { LocationPicker } from './LocationPicker';
import { useToast } from '../../ui/Toast';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { todayIsoInZone } from '../../../lib/date';
import { humanizeError } from '../../../lib/errors';
import {
  createCategory,
  createInventoryItem,
  createUnit,
  pickDefaultLocation,
  updateInventoryItem,
} from '../../../lib/inventory';
import {
  checkName,
  cleanName,
  codeClashMessage,
  exactDuplicateMessage,
  fetchNameIndex,
  similarNamesMessage,
  SIMILAR_CONFIRMATION,
  type NameIndexEntry,
  type NameVerdict,
} from '../../../lib/inventoryDuplicates';
import {
  newIdempotencyKey,
  postOpeningBalance,
  stockErrorMessage,
} from '../../../lib/stock';
import { ItemImageField } from './ItemImageField';
import {
  ItemFormFields,
  type ItemFormValues,
  type NewUnitDraft,
} from './ItemFormFields';
import type {
  InventoryCategory,
  InventoryItem,
  StockLocation,
  UnitOfMeasure,
} from '../../../types/inventory';

// ADD OR EDIT A PRODUCT — the ERP's right-hand slide-over, with the one change
// this brief asks for: adding a product can record what is already on the shelf,
// in the same pass.
//
// WHY THE TWO STEPS ARE MERGED. Until now, putting a new item into the system
// meant "create the item" on one screen and then "record its opening balance" on
// another — and the second step is the one people forget, which leaves a
// catalogue full of items the system believes it holds none of. Asking for the
// quantity while the person is still holding the delivery note is the difference
// between a stock figure that is right on day one and one that is quietly wrong.
//
// THE OPENING BALANCE IS OPTIONAL AND STARTS EMPTY (rule 10, applied beyond
// payments for the same reason): a pre-filled quantity would be a claim about
// stock nobody counted. Leave it blank and only the catalogue item is created.
//
// TWO WRITES, NOT ONE TRANSACTION, AND THE SCREEN SAYS SO WHEN IT MATTERS. The
// item is an ordinary admin-gated insert (035); the opening balance is a
// SECURITY DEFINER RPC (036 §4.1) that resolves the tenant, checks the staff
// gate, refuses a future date and enforces one opening per item per location.
// There is no RPC that does both, and inventing one would put a second
// definition of "create an item" in the database. So if the item is created and
// the balance is refused, this says exactly that — the item exists, the stock
// does not, here is why, and the balance can be recorded from the row. What it
// never does is report success for half a job.

interface ItemPanelProps {
  tenantId: string;
  propertyId: string;
  // NULL = add. A row = edit; the opening-balance section is hidden, because an
  // item that already exists is corrected with an adjustment, never re-opened
  // (036 refuses a second opening balance structurally).
  item: InventoryItem | null;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  locations: StockLocation[];
  referenceLoading: boolean;
  currency: string;
  timezone: string;
  // The location currently being viewed, so the opening balance defaults to
  // where the person is already looking. NULL means "all locations", and the
  // fallback is then the property's designated receiving store (037).
  defaultLocationId: string | null;
  // Re-pulls the tenant's units and categories after the inline "+ New" adds
  // one, so the picker it was added from can select it.
  onReferenceChanged: () => Promise<void> | void;
  onSaved: () => Promise<void> | void;
  onClose: () => void;
}

const EMPTY_ITEM_FORM: ItemFormValues = {
  name: '',
  code: '',
  // 'raw' is the safe default: an ingredient that is never sold directly. If the
  // owner leaves it, the worst case is an item that cannot be sold until they
  // change it — visible immediately. Defaulting to 'finished' or 'both' would
  // instead let a mis-typed item be SOLD without ever deducting a recipe, which
  // surfaces months later as stock that never moves.
  itemType: 'raw',
  baseUnit: '',
  categoryId: '',
  isPerishable: false,
  tracksExpiry: false,
  reorderLevel: null,
  barcode: '',
  packSize: '',
  purchaseCost: null,
  minStockLevel: null,
  maxStockLevel: null,
  // 042. Blank, and blank means NOT SOLD. Never seeded with a number — a
  // pre-filled price is a claim about what a hotel charges that nobody made
  // (rule 10's principle, applied past payments for the same reason).
  sellingPrice: null,
  isActive: true,
};

// numeric columns arrive as STRINGS over PostgREST (§6) and every one of them is
// nullable, where NULL means "not stated". parseNumeric is the one place that
// distinction is handled correctly — Number('') is 0, which would turn an
// unstated cost into a claim that the item is free.
function toForm(item: InventoryItem): ItemFormValues {
  return {
    name: item.name,
    code: item.code ?? '',
    itemType: item.item_type,
    baseUnit: item.base_unit,
    categoryId: item.category_id ?? '',
    isPerishable: item.is_perishable,
    tracksExpiry: item.tracks_expiry,
    // The catalogue's figures are numbers by the time they reach a component
    // (rule 24), so the form takes them as they are.
    reorderLevel: item.reorder_level,
    barcode: item.barcode ?? '',
    packSize: item.pack_size ?? '',
    purchaseCost: item.purchase_cost,
    minStockLevel: item.min_stock_level,
    maxStockLevel: item.max_stock_level,
    sellingPrice: item.default_selling_price,
    isActive: item.is_active,
  };
}

export function ItemPanel({
  tenantId,
  propertyId,
  item,
  units,
  categories,
  locations,
  referenceLoading,
  currency,
  timezone,
  defaultLocationId,
  onReferenceChanged,
  onSaved,
  onClose,
}: ItemPanelProps) {
  const toast = useToast();
  const today = todayIsoInZone(timezone);
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  const [values, setValues] = useState<ItemFormValues>(() =>
    item ? toForm(item) : EMPTY_ITEM_FORM,
  );
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // THE DUPLICATE CHECK. Every live name and code in the tenant catalogue,
  // loaded once when the panel opens — a few hundred short strings, which is
  // cheaper than a round trip on every keystroke and, more importantly, cannot
  // race the typing. See lib/inventoryDuplicates for the method.
  //
  // It is a COURTESY, never the guard (rule 19 in its own shape): 035's unique
  // indexes on lower(name) and lower(code) are what actually hold, and they
  // hold in the case this can never see — two people saving the same name at
  // the same moment, where both reads finish before either write. handleSave
  // therefore still treats a 23505 as a real outcome.
  const [nameIndex, setNameIndex] = useState<NameIndexEntry[] | null>(null);
  // The near-matches the user has been shown but not yet acted on. Non-null
  // means the save is HELD, waiting for an explicit confirmation.
  const [pendingSimilar, setPendingSimilar] = useState<NameVerdict | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchNameIndex(tenantId);
        if (!cancelled) setNameIndex(rows);
      } catch {
        // Deliberately NOT surfaced as a blocking error, and deliberately not
        // blocking the save. Losing the courtesy check costs a friendly warning;
        // refusing to let anyone add an item because a duplicate LIST failed to
        // load would be a far worse trade. The unique index still refuses a real
        // duplicate, and handleSave turns that into the same sentence.
        if (!cancelled) setNameIndex([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId]);

  // The opening-stock section. Empty by default, on purpose.
  //
  // The location is a CHOICE the user has not made yet rather than a value that
  // needs defaulting into state: '' means "untouched", and the effective value
  // is derived below. Seeding it from an effect would fire a second render every
  // time the locations arrive, and the locations arrive after the first paint.
  const [openingLocationChoice, setOpeningLocationChoice] = useState('');
  const [openingQuantity, setOpeningQuantity] = useState<number | null>(null);
  const [openingCost, setOpeningCost] = useState<number | null>(null);
  const [openingDate, setOpeningDate] = useState(today);
  const [openingNote, setOpeningNote] = useState('');

  // Where the person is already looking, then the property's designated
  // receiving store (037 — stock is received into a store and issued out of it),
  // then nowhere. Never "whatever sorts first", which is an ordering accident.
  const openingLocationId =
    openingLocationChoice ||
    defaultLocationId ||
    pickDefaultLocation(locations)?.id ||
    '';

  // ---------------------------------------------------------------------
  // The inline "+ New unit" / "+ New category"
  // ---------------------------------------------------------------------
  // A value created here is held LOCALLY as well as reloaded from the server.
  // The reload is what keeps every other picker on the page in step; the local
  // copy is what lets this form select the new value on the SAME render, so the
  // select never briefly holds a value that is not among its options (which a
  // browser renders as an empty box, exactly when the user is watching).
  const [extraUnits, setExtraUnits] = useState<UnitOfMeasure[]>([]);
  const [extraCategories, setExtraCategories] = useState<InventoryCategory[]>([]);

  const allUnits = mergeById(units, extraUnits);
  const allCategories = mergeById(categories, extraCategories);

  async function handleCreateUnit(draft: NewUnitDraft) {
    // Appended past the last one, in tens, so a later manual re-ordering has
    // room between entries — the same rule the categories panel uses.
    const nextOrder =
      allUnits.reduce((max, u) => Math.max(max, u.display_order), 0) + 10;
    // Throws on failure; ItemFormFields shows the reason against the box the
    // user is standing in (rule 11 — never swallowed, never a silent no-op).
    const created = await createUnit(tenantId, {
      unit_code: draft.unitCode,
      name: draft.name,
      dimension: draft.dimension,
      display_order: nextOrder,
    });
    setExtraUnits((prev) => [...prev, created]);
    setValues((prev) => ({ ...prev, baseUnit: created.unit_code }));
    await onReferenceChanged();
  }

  async function handleCreateCategory(name: string) {
    const nextOrder =
      allCategories.reduce((max, c) => Math.max(max, c.display_order), 0) + 10;
    const created = await createCategory(tenantId, {
      name,
      display_order: nextOrder,
    });
    setExtraCategories((prev) => [...prev, created]);
    setValues((prev) => ({ ...prev, categoryId: created.id }));
    await onReferenceChanged();
  }

  const isEdit = item !== null;
  const wantsOpening = !isEdit && (openingQuantity !== null || openingCost !== null);

  // The row behind the resolved opening location, for the picker's label. The panel
  // already holds the property's locations (it derives the default from them); only
  // the SEARCH goes to the server (rule 26).
  const openingLocation =
    locations.find((l) => l.id === openingLocationId) ?? null;

  function patch(next: Partial<ItemFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
    if (next.name !== undefined) setNameError(undefined);
    // Editing either field the check is about withdraws the confirmation. The
    // user agreed that ONE set of names was genuinely distinct; changing the
    // name and saving must not ride on that agreement.
    if (next.name !== undefined || next.code !== undefined) {
      setPendingSimilar(null);
    }
  }

  async function handleSave() {
    setFormError(null);

    if (!cleanName(values.name)) {
      setNameError('An item name is required.');
      return;
    }
    if (!values.baseUnit) {
      setFormError('Choose the unit this item is measured in.');
      return;
    }
    // A courtesy for 037's min/max constraint, which would otherwise surface as
    // a constraint name (rule 19: the DB check is the guard, this is the wording).
    if (
      values.minStockLevel !== null &&
      values.maxStockLevel !== null &&
      values.maxStockLevel < values.minStockLevel
    ) {
      setFormError('Max stock cannot be below min stock.');
      return;
    }

    // --- duplicates, before anything is written --------------------------
    // Skipped entirely while the index is still loading rather than blocking
    // the save on it: the database check below is the real one.
    if (nameIndex !== null) {
      const verdict = checkName(
        cleanName(values.name),
        values.code.trim() || null,
        nameIndex,
        // An edit must not report the row being edited as a duplicate of
        // itself, nor as similar to itself.
        item?.id ?? null,
      );

      // EXACT — blocked. Shown against the field it is about, so the fix is
      // where the cursor already is.
      if (verdict.exact) {
        setNameError(exactDuplicateMessage(verdict.exact));
        return;
      }
      if (verdict.codeClash) {
        setFormError(codeClashMessage(verdict.codeClash));
        return;
      }

      // SIMILAR — warned once, then the save is held until the user confirms.
      // The second press goes through, because by then pendingSimilar is set
      // and this branch is skipped.
      if (verdict.similar.length > 0 && pendingSimilar === null) {
        setPendingSimilar(verdict);
        return;
      }
    }

    // Courtesy checks only (rule 19): the server re-checks every one of these,
    // and 036 refuses an opening balance with no cost outright.
    if (wantsOpening) {
      if (!openingLocationId) {
        setFormError('Choose which location already holds this stock.');
        return;
      }
      if (openingQuantity === null || openingQuantity <= 0) {
        setFormError(
          'Enter how much is on hand, as a number greater than zero — or clear the cost to add the item on its own.',
        );
        return;
      }
      if (openingCost === null) {
        setFormError(
          `Enter what one ${values.baseUnit || 'unit'} cost. It is what this stock is worth, and there is no history to work it out from.`,
        );
        return;
      }
    }

    setSaving(true);
    try {
      if (isEdit) {
        // rule 11: awaited, in try/catch, error surfaced — never fire-and-forget.
        await updateInventoryItem(item.id, tenantId, {
          ...itemFieldsFrom(values),
          is_active: values.isActive,
        });
        toast.success('Item saved.');
        await onSaved();
        onClose();
        return;
      }

      const created = await createInventoryItem(tenantId, {
        ...itemFieldsFrom(values),
        is_active: true,
        // The catalogue lists alphabetically, so a new item needs no position;
        // display_order is reserved for later curated groupings.
        display_order: 0,
      });

      if (!wantsOpening) {
        toast.success('Item added.');
        await onSaved();
        onClose();
        return;
      }

      try {
        await postOpeningBalance({
          propertyId,
          locationId: openingLocationId,
          inventoryItemId: created.id,
          quantity: openingQuantity!,
          unitCost: openingCost!,
          businessDate: openingDate || null,
          note: openingNote.trim() || null,
          // Rules 2/3: a fresh key per submit INTENT. A double-click cannot post
          // the balance twice, and the once-per-item-per-location index refuses
          // a second one under any key regardless.
          idempotencyKey: newIdempotencyKey(),
        });
      } catch (e) {
        // The half-done case, reported as exactly what it is. The item is real
        // and the list will show it; only the balance failed, and 036 raises
        // sentences a storekeeper can act on, so its own message is shown.
        setFormError(
          `“${created.name}” was added to your catalogue, but its opening stock was not recorded: ${stockErrorMessage(e)} You can record it from the item’s row.`,
        );
        await onSaved();
        return;
      }

      toast.success('Item added, with its opening stock.');
      await onSaved();
      onClose();
    } catch (e) {
      // THE BACKSTOP FIRING. 035's unique indexes are what actually stop a
      // duplicate, and they catch the case the read-side check above cannot
      // see: somebody else saved this name in the moment between the panel
      // loading its index and this insert. humanizeError would say "That
      // already exists. Please use a different value." — true, and useless
      // about WHICH value — so the two indexes are named apart here and the
      // message points at the field to fix.
      const code = (e as { code?: string; message?: string } | null)?.code;
      const detail = (e as { message?: string } | null)?.message ?? '';
      if (code === '23505') {
        if (detail.includes('code')) {
          setFormError(
            `The code “${values.code.trim()}” is already used by another item. Give this one a different code, or leave it blank.`,
          );
        } else {
          setNameError(
            `An item named “${cleanName(values.name)}” already exists in your catalogue. Use that one, or give this a different name.`,
          );
        }
        return;
      }
      setFormError(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  const noUnits = !referenceLoading && allUnits.length === 0;
  const blocked = referenceLoading || noUnits;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <div
        className="absolute inset-0 bg-charcoal/40"
        onClick={saving ? undefined : onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={isEdit ? `Edit ${item.name}` : 'Add product'}
        className="relative flex h-full w-full max-w-xl flex-col bg-cream shadow-2xl"
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-sand-border px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-charcoal">
              {isEdit ? `Edit ${item.name}` : 'Add product'}
            </h2>
            <p className="mt-0.5 text-xs text-charcoal-muted">
              {isEdit
                ? 'Changes apply everywhere this item is used. Its stock and history are untouched.'
                : 'Define the item once for the whole group, and record what is already on the shelf if you know it.'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6">
          {referenceLoading ? (
            <p
              className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted"
              aria-live="polite"
            >
              Loading units and categories…
            </p>
          ) : noUnits ? (
            <p className="mb-4 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
              There are no units of measure set up, so an item cannot be created
              yet.
            </p>
          ) : null}

          <section>
            <h3 className="mb-3 text-sm font-semibold text-charcoal">
              What it is
            </h3>
            <ItemFormFields
              values={values}
              onChange={patch}
              units={allUnits}
              categories={allCategories}
              currency={currency}
              disabled={saving || blocked}
              nameError={nameError}
              showActive={isEdit}
              onCreateUnit={handleCreateUnit}
              onCreateCategory={handleCreateCategory}
            />
          </section>

          {/* THE PICTURE (1.1e §3), on an item that exists.
              On the ADD form this is one line saying where to find it, not an
              upload — see ItemImageField's header for why: an upload before the
              item exists creates files nothing references, and tenant-level media
              deliberately has no orphan sweeper to find them. */}
          <section className="mt-6 rounded-2xl border border-sand-border bg-white/60 p-4">
            <h3 className="text-sm font-semibold text-charcoal">
              Picture{' '}
              <span className="font-normal text-charcoal-muted">— optional</span>
            </h3>
            {isEdit ? (
              <div className="mt-3">
                <ItemImageField
                  tenantId={tenantId}
                  itemId={item.id}
                  itemName={item.name}
                  imageAssetId={item.image_asset_id}
                  onChanged={onSaved}
                  disabled={saving}
                />
              </div>
            ) : (
              <p className="mt-1 text-xs text-charcoal-muted">
                Add the item first, then open it again to give it a picture.
              </p>
            )}
          </section>

          {!isEdit ? (
            <section className="mt-6 rounded-2xl border border-sand-border bg-white/60 p-4">
              <h3 className="text-sm font-semibold text-charcoal">
                What is already on the shelf{' '}
                <span className="font-normal text-charcoal-muted">
                  — optional
                </span>
              </h3>
              <p className="mt-1 text-xs text-charcoal-muted">
                Leave this blank to add the item on its own. Fill it in and the
                quantity is recorded as an opening balance — what this location
                held when you started using the system. It can only be recorded
                once per item per location; after that, corrections are
                adjustments.
              </p>

              {locations.length === 0 ? (
                <p className="mt-3 text-xs text-charcoal-muted">
                  This hotel has no stock locations yet, so there is nowhere to
                  record a balance. Add one under “Manage locations”.
                </p>
              ) : (
                <div className="mt-3 grid gap-4 sm:grid-cols-2">
                  {/* Searchable, server-side (rule 26). This writes an opening
                      balance, so only locations in use are offered. */}
                  <LocationPicker
                    tenantId={tenantId}
                    propertyId={propertyId}
                    value={openingLocationId}
                    onChange={setOpeningLocationChoice}
                    selectedLocation={openingLocation}
                    activeOnly
                    disabled={saving || blocked}
                  />
                  <NumberField
                    label={`How much is on hand${values.baseUnit ? ` (${values.baseUnit})` : ''}`}
                    value={openingQuantity}
                    onChange={setOpeningQuantity}
                    min={0}
                    step="any"
                    placeholder="Leave blank for none"
                    disabled={saving || blocked}
                  />
                  <CurrencyField
                    label={`Cost per ${values.baseUnit || 'unit'}`}
                    value={openingCost}
                    onChange={setOpeningCost}
                    currency={currency}
                    disabled={saving || blocked}
                    helpText="What one unit cost you. This is what the stock on hand is worth."
                  />
                  <DateField
                    label="As at"
                    value={openingDate}
                    onChange={setOpeningDate}
                    max={today}
                    disabled={saving || blocked}
                    helpText="The day it was counted — not today, if they differ."
                  />
                  <div className="sm:col-span-2">
                    <TextField
                      label="Note"
                      value={openingNote}
                      onChange={setOpeningNote}
                      placeholder="e.g. Counted with the chef"
                      disabled={saving || blocked}
                    />
                  </div>
                </div>
              )}
            </section>
          ) : null}

          {/* THE FUZZY BLOCKER. Not a toast and not a window.confirm: it names
              the items it is worried about, beside the form, and stays on
              screen while the user decides. Pressing Save again is the
              confirmation — the button relabels itself so it is obvious that
              the second press is a different, deliberate act. */}
          {pendingSimilar ? (
            <div
              className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3"
              role="alert"
            >
              <h4 className="text-sm font-semibold text-charcoal">
                This name looks like {pendingSimilar.similar.length === 1
                  ? 'one you already have'
                  : 'ones you already have'}
              </h4>
              <p className="mt-1 text-sm text-charcoal">
                {similarNamesMessage(pendingSimilar)}
              </p>
              <ul className="mt-2 space-y-1">
                {pendingSimilar.similar.map((s) => (
                  <li key={s.item.id} className="text-sm text-charcoal">
                    • {s.item.name}
                    {s.item.is_active ? '' : ' (switched off)'}
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-sm font-semibold text-charcoal">
                {SIMILAR_CONFIRMATION}
              </p>
            </div>
          ) : null}

          {formError ? (
            <p
              className="mt-4 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm font-medium text-charcoal"
              role="alert"
            >
              {formError}
            </p>
          ) : null}
        </div>

        <footer className="flex flex-none flex-wrap items-center gap-2 border-t border-sand-border px-4 py-4 sm:px-6">
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || blocked}
            className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            {saving
              ? 'Saving…'
              : pendingSimilar
                ? 'Yes — create it anyway'
                : isEdit
                  ? 'Save item'
                  : wantsOpening
                    ? 'Add item and stock'
                    : 'Add item'}
          </button>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
        </footer>
      </div>
    </div>
  );
}

// The form's values as the columns 035/037 hold. ONE conversion, shared by the
// create and the edit path, so the two can never write different sets of fields
// — the bug shape where a new field is saved on create and silently dropped on
// every subsequent edit.
//
// EVERY OPTIONAL TEXT FIELD BECOMES NULL WHEN BLANK, never ''. The database
// treats them differently and it matters: 037's barcode index is partial on
// `barcode is not null`, so two items each carrying an empty-string barcode
// would collide and the user would be told their barcode is taken by an item
// that visibly has none.
function itemFieldsFrom(values: ItemFormValues): {
  name: string;
  code: string | null;
  item_type: ItemFormValues['itemType'];
  base_unit: string;
  category_id: string | null;
  is_perishable: boolean;
  tracks_expiry: boolean;
  reorder_level: number | null;
  barcode: string | null;
  pack_size: string | null;
  purchase_cost: number | null;
  min_stock_level: number | null;
  max_stock_level: number | null;
  default_selling_price: number | null;
} {
  return {
    name: cleanName(values.name),
    code: values.code.trim() || null,
    item_type: values.itemType,
    base_unit: values.baseUnit,
    category_id: values.categoryId || null,
    is_perishable: values.isPerishable,
    tracks_expiry: values.tracksExpiry,
    reorder_level: values.reorderLevel,
    barcode: values.barcode.trim() || null,
    pack_size: values.packSize.trim() || null,
    purchase_cost: values.purchaseCost,
    min_stock_level: values.minStockLevel,
    max_stock_level: values.maxStockLevel,
    // 042. Sent as NULL when blank, which is what NOT SOLD is. The form removes the
    // field entirely for an Ingredient and clears the value with it, so this is
    // never a number on a raw item — and if it somehow were, the CHECK refuses it.
    default_selling_price: values.sellingPrice,
  };
}

// The server's list plus anything created inline since it loaded, de-duplicated
// by id so a reload that already carries the new row does not list it twice.
function mergeById<T extends { id: string }>(base: T[], extra: T[]): T[] {
  if (extra.length === 0) return base;
  const known = new Set(base.map((row) => row.id));
  return [...base, ...extra.filter((row) => !known.has(row.id))];
}
