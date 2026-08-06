import { useRef, useState } from 'react';
import {
  CurrencyField,
  DateField,
  NumberField,
  Select,
  TextField,
} from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { todayIsoInZone } from '../../../lib/date';
import { humanizeError } from '../../../lib/errors';
import { createInventoryItem, updateInventoryItem } from '../../../lib/inventory';
import {
  newIdempotencyKey,
  postOpeningBalance,
  stockErrorMessage,
} from '../../../lib/stock';
import { ItemFormFields, type ItemFormValues } from './ItemFormFields';
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
  // where the person is already looking.
  defaultLocationId: string | null;
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
  reorderLevel: null,
  isActive: true,
};

function toForm(item: InventoryItem): ItemFormValues {
  return {
    name: item.name,
    code: item.code ?? '',
    itemType: item.item_type,
    baseUnit: item.base_unit,
    categoryId: item.category_id ?? '',
    isPerishable: item.is_perishable,
    // reorder_level is numeric(14,4) and arrives as a STRING (§6). Parsed by the
    // caller's Number() would give a silent 0 for ''; the field wants null.
    reorderLevel: item.reorder_level === null ? null : Number(item.reorder_level),
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

  // Where the person is already looking, then the first location, then nowhere.
  const openingLocationId =
    openingLocationChoice || defaultLocationId || locations[0]?.id || '';

  const isEdit = item !== null;
  const wantsOpening = !isEdit && (openingQuantity !== null || openingCost !== null);

  const locationOptions: SelectOption[] = locations.map((l) => ({
    value: l.id,
    label: l.is_active ? l.name : `${l.name} (closed)`,
  }));

  function patch(next: Partial<ItemFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
    if (next.name !== undefined) setNameError(undefined);
  }

  async function handleSave() {
    setFormError(null);

    if (!values.name.trim()) {
      setNameError('An item name is required.');
      return;
    }
    if (!values.baseUnit) {
      setFormError('Choose the unit this item is measured in.');
      return;
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
          name: values.name.trim(),
          code: values.code.trim() || null,
          item_type: values.itemType,
          base_unit: values.baseUnit,
          category_id: values.categoryId || null,
          is_perishable: values.isPerishable,
          reorder_level: values.reorderLevel,
          is_active: values.isActive,
        });
        toast.success('Item saved.');
        await onSaved();
        onClose();
        return;
      }

      const created = await createInventoryItem(tenantId, {
        name: values.name.trim(),
        code: values.code.trim() || null,
        item_type: values.itemType,
        base_unit: values.baseUnit,
        category_id: values.categoryId || null,
        is_perishable: values.isPerishable,
        reorder_level: values.reorderLevel,
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
      setFormError(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  const noUnits = !referenceLoading && units.length === 0;
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
              units={units}
              categories={categories}
              disabled={saving || blocked}
              nameError={nameError}
              showActive={isEdit}
            />
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
                  <Select
                    label="Location"
                    value={openingLocationId}
                    onChange={setOpeningLocationChoice}
                    options={locationOptions}
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
