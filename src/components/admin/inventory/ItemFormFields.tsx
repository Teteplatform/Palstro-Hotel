import { useState } from 'react';
import {
  CurrencyField,
  NumberField,
  Select,
  TextField,
  Toggle,
} from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { PlusIcon } from '../../ui/icons';
import {
  ITEM_TYPES,
  itemTypeHint,
  itemTypeLabel,
  unitDimensionLabel,
} from '../../../lib/inventoryLabels';
import { TRACKS_EXPIRY_EXPLANATION } from '../../../lib/stockLabels';
import type {
  InventoryCategory,
  ItemType,
  UnitDimension,
  UnitOfMeasure,
} from '../../../types/inventory';

// The item field set, shared by "add an item" and "edit an item" so the two can
// never drift into asking different questions or explaining a choice two
// different ways. Purely presentational: it owns no state beyond its own
// quick-add drafts and performs no write — the panel above does every write.
//
// Laid out as a two-column grid that COLLAPSES TO ONE at the sm breakpoint, so
// the whole form is usable at 360px — this is owner/manager setup work that gets
// done on a phone in the store as often as at a desk.
//
// ---------------------------------------------------------------------------
// THE INLINE "+ NEW" ON UNIT AND CATEGORY — and why TYPE has none
// ---------------------------------------------------------------------------
// Base unit and Category are REFERENCE DATA (035 §1, §2): tables a tenant adds
// to, precisely so that a hotel buying yam by the tuber does not need a code
// change. The old flow made you leave a half-filled form, find the Categories
// tab, add the value, come back and start again — so people picked whatever was
// already in the list, which is how a catalogue ends up with every fresh item
// filed under "Groceries". The quick-add is a field and a button, not a screen.
//
// TYPE HAS NO "+ NEW", DELIBERATELY. raw / finished / both is not reference
// data — it is a CHECK constraint (035 §3) and, more to the point, it is
// BEHAVIOUR the engine branches on: whether a sale deducts this item directly,
// through a recipe, or both. A fourth value would have nothing to branch to, so
// creating one from a form could only ever produce an item the engine cannot
// account for. Three choices, no plus.
//
// ---------------------------------------------------------------------------
// THE STANDARD FIELD SET (037), and what is still missing on purpose
// ---------------------------------------------------------------------------
// Barcode, pack size, purchase cost and the min/max par range are captured here.
// SUPPLIER is not — it belongs to purchasing, where it is a table and not one
// text box (a hotel buys rice from three people at three prices).
//
// SELLING PRICE IS NOW HERE, and this comment used to say it never would be. The
// old reason was that "the same Coke sells at one price at the bar and another in
// the restaurant", so a price belonged to a menu line. That fact is true and the
// conclusion drawn from it was wrong: it left a hotel unable to say what a crate
// of Coke is worth until a whole menu module existed, and it left every outlet
// charging the ordinary price with nothing to inherit, so one number got typed
// once per outlet and drifted. 042 puts the DEFAULT on the item; 1.1g adds the
// outlet OVERRIDE that reads from it. Both facts, one place to maintain.
//
// ---------------------------------------------------------------------------
// THE PRICE FIELD ONLY EXISTS FOR AN ITEM THAT IS SOLD
// ---------------------------------------------------------------------------
// It renders for Sold as-is and Both, and NOT for Ingredient — because the
// database refuses a price on an Ingredient outright
// (inventory_items_raw_has_no_price_check), so a box that could only ever produce
// a constraint error is not a field, it is a trap. Switching the Type back to
// Ingredient clears the price with it, in the same act, so the form can never
// submit a combination the database will reject.
//
// The reverse rule — a sold item MUST have a price — is NOT restated here (rule
// 21). The trigger in 042 §1.2 raises it, with the rule in its message and the way
// out in its hint, and the panel shows both verbatim. A copy of the check in this
// file would be a second source of truth that drifts the day the rule changes,
// silently, because nothing errors when a client forgets one.

// A UI form shape, not a DB row — the DB row is InventoryItem in types/inventory.
// Fields are the plain values the controls hold: '' for "not set" on text and
// select, null for "not stated" on every number.
export interface ItemFormValues {
  name: string;
  code: string;
  itemType: ItemType;
  baseUnit: string;
  categoryId: string;
  isPerishable: boolean;
  tracksExpiry: boolean;
  reorderLevel: number | null;
  barcode: string;
  packSize: string;
  purchaseCost: number | null;
  minStockLevel: number | null;
  maxStockLevel: number | null;
  // 042. NULL means NOT SOLD — the same distinction the column carries, held as
  // null rather than as 0 all the way from the box to the database. CurrencyField
  // already gives null for an empty field rather than Number('') === 0, which is
  // what makes that possible without a special case here.
  sellingPrice: number | null;
  isActive: boolean;
}

// What the quick-add hands back. The panel owns the write and the reference
// reload; this component only collects the fields and reports the draft.
export interface NewUnitDraft {
  unitCode: string;
  name: string;
  dimension: UnitDimension;
}

interface ItemFormFieldsProps {
  values: ItemFormValues;
  onChange: (patch: Partial<ItemFormValues>) => void;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  // The property's own currency code for the purchase-cost field (rule 17 — it
  // arrives from the database, never a literal).
  currency: string;
  disabled?: boolean;
  nameError?: string;
  // Edit forms hide the "active" toggle from the create panel, where a new item
  // is always active — a control whose only sensible value is its default is
  // noise on a create form.
  showActive?: boolean;
  // Quick-add. Both throw on failure so this component can show the reason
  // against the field the user is standing in (rule 11 — never swallowed).
  // Omitted => the affordance is not rendered at all, rather than rendered dead.
  onCreateUnit?: (draft: NewUnitDraft) => Promise<void>;
  onCreateCategory?: (name: string) => Promise<void>;
}

const UNIT_DIMENSIONS: UnitDimension[] = ['mass', 'volume', 'count', 'length'];

export function ItemFormFields({
  values,
  onChange,
  units,
  categories,
  currency,
  disabled,
  nameError,
  showActive = true,
  onCreateUnit,
  onCreateCategory,
}: ItemFormFieldsProps) {
  // Only ACTIVE units are offered for a new choice, but a unit that has since
  // been retired must still appear when it is the item's current one —
  // otherwise editing an unrelated field would silently blank the unit.
  const unitOptions: SelectOption[] = units
    .filter((u) => u.is_active || u.unit_code === values.baseUnit)
    .map((u) => ({ value: u.unit_code, label: `${u.name} (${u.unit_code})` }));

  // Same rule for categories, plus an explicit "no category" choice — filing an
  // item is optional, and forcing a junk category is worse than an honest blank.
  const categoryOptions: SelectOption[] = [
    { value: '', label: 'No category' },
    ...categories
      .filter((c) => c.is_active || c.id === values.categoryId)
      .map((c) => ({ value: c.id, label: c.name })),
  ];

  const typeOptions: SelectOption[] = ITEM_TYPES.map((t) => ({
    value: t,
    label: itemTypeLabel(t),
  }));

  // The thresholds are measured in the item's own base unit, so the help text
  // says which — "20" means nothing without "kg".
  const unitLabel =
    units.find((u) => u.unit_code === values.baseUnit)?.unit_code ?? 'units';

  // Whether this item is sold at all, which is what decides whether a price is a
  // field or a trap. Derived from the CURRENT form value, not from the saved row,
  // so switching Type reveals or removes the box immediately.
  const sellable = values.itemType === 'finished' || values.itemType === 'both';

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <TextField
        label="Item name"
        required
        value={values.name}
        onChange={(v) => onChange({ name: v })}
        error={nameError}
        placeholder="e.g. Rice"
        disabled={disabled}
      />

      <TextField
        label="Code"
        value={values.code}
        onChange={(v) => onChange({ code: v })}
        placeholder="Optional"
        helpText="Your own short reference. Leave blank if you don't use one."
        disabled={disabled}
      />

      <Select
        label="Type"
        required
        value={values.itemType}
        onChange={(v) => {
          const itemType = v as ItemType;
          // CHANGING TO Ingredient CLEARS THE PRICE, in the same act. The database
          // refuses a raw item with a price, so leaving a stale value in state
          // would mean the form submits a combination that can only fail — and it
          // would fail naming a constraint rather than the field somebody just
          // changed. Cleared here, so the two controls can never disagree.
          onChange(
            itemType === 'raw'
              ? { itemType, sellingPrice: null }
              : { itemType },
          );
        }}
        options={typeOptions}
        // The hint follows the CHOICE, so the consequence of the selection is
        // visible at the moment it is made rather than in a legend elsewhere.
        // No "+ New" here — see the header.
        helpText={itemTypeHint(values.itemType)}
        disabled={disabled}
      />

      <div>
        <Select
          label="Base unit"
          required
          value={values.baseUnit}
          onChange={(v) => onChange({ baseUnit: v })}
          options={unitOptions}
          placeholder={values.baseUnit ? undefined : 'Choose a unit…'}
          helpText="The smallest unit you measure in. Everything is entered in it."
          disabled={disabled}
        />
        {onCreateUnit ? (
          <QuickAddUnit
            disabled={disabled}
            onCreate={onCreateUnit}
            dimensions={UNIT_DIMENSIONS}
          />
        ) : null}
      </div>

      <div>
        <Select
          label="Category"
          value={values.categoryId}
          onChange={(v) => onChange({ categoryId: v })}
          options={categoryOptions}
          helpText="Groups this item in your reports."
          disabled={disabled}
        />
        {onCreateCategory ? (
          <QuickAddCategory disabled={disabled} onCreate={onCreateCategory} />
        ) : null}
      </div>

      <TextField
        label="Barcode"
        value={values.barcode}
        onChange={(v) => onChange({ barcode: v })}
        placeholder="Optional"
        helpText="The code on the packaging."
        disabled={disabled}
      />

      <TextField
        label="Pack size"
        value={values.packSize}
        onChange={(v) => onChange({ packSize: v })}
        placeholder="e.g. carton of 24"
        // Said in one line because it is the field most likely to be
        // misunderstood: stock is still counted in the base unit, always.
        helpText={`How it is packed. Stock is still counted in ${unitLabel}.`}
        disabled={disabled}
      />

      <CurrencyField
        label="Purchase cost"
        value={values.purchaseCost}
        onChange={(v) => onChange({ purchaseCost: v })}
        currency={currency}
        placeholder="Optional"
        helpText={`What one ${unitLabel} normally costs to buy. Your stock is still valued at what you actually paid.`}
        disabled={disabled}
      />

      {/* SELLING PRICE, beside purchase cost, and only for an item that is sold.
          The pairing is deliberate: buy price and sell price are the two numbers
          somebody setting up an item wants to see together. */}
      {sellable ? (
        <CurrencyField
          label="Selling price"
          required
          value={values.sellingPrice}
          onChange={(v) => onChange({ sellingPrice: v })}
          currency={currency}
          // The one hint that genuinely earns its place here (rule 25): "before
          // tax" changes the number a person types, and the label cannot carry it.
          // Everything else about pricing — outlet overrides, what blank means for
          // an ingredient — is in the ⓘ and the guide.
          helpText={`What one ${unitLabel} sells for, before tax. An outlet can charge something different.`}
          disabled={disabled}
        />
      ) : null}

      <NumberField
        label="Reorder level"
        value={values.reorderLevel}
        onChange={(v) => onChange({ reorderLevel: v })}
        min={0}
        step="any"
        placeholder="Optional"
        helpText={`Warn below this many ${unitLabel}. Blank = not tracked.`}
        disabled={disabled}
      />

      <NumberField
        label="Min stock"
        value={values.minStockLevel}
        onChange={(v) => onChange({ minStockLevel: v })}
        min={0}
        step="any"
        placeholder="Optional"
        helpText="Ordering floor. The warning uses Reorder level."
        disabled={disabled}
      />

      <NumberField
        label="Max stock"
        value={values.maxStockLevel}
        onChange={(v) => onChange({ maxStockLevel: v })}
        min={0}
        step="any"
        placeholder="Optional"
        helpText="Ordering ceiling — how far up to top an order."
        disabled={disabled}
      />

      {/* TWO NEIGHBOURING BOOLEANS THAT SOUND ALIKE AND ARE NOT, so they sit
          together and each says what it actually does. "Perishable" describes
          the GOODS and has no consequences; "Track batch and expiry" describes
          the WORK and adds two required fields to every delivery. Labelling the
          second one "expiry" alone would have read as a restatement of the
          first, and the storekeeper would meet the difference as a validation
          error instead of as a choice. */}
      <Toggle
        label="Perishable"
        value={values.isPerishable}
        onChange={(v) => onChange({ isPerishable: v })}
        helpText="Describes the goods only — it changes nothing about how stock is recorded."
        disabled={disabled}
      />

      <Toggle
        label="Track batch and expiry"
        value={values.tracksExpiry}
        onChange={(v) => onChange({ tracksExpiry: v })}
        helpText={TRACKS_EXPIRY_EXPLANATION}
        disabled={disabled}
      />

      {showActive ? (
        <Toggle
          label="In use"
          value={values.isActive}
          onChange={(v) => onChange({ isActive: v })}
          helpText="Turn off to keep the item on file but hide it from new entries."
          disabled={disabled}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The quick-adds
// ---------------------------------------------------------------------------

// A shared shell so the unit and category versions cannot drift into two
// different shapes: a small "+ New …" button that becomes a tiny field row, and
// closes again once the value has been created and selected.
function QuickAddShell({
  label,
  disabled,
  open,
  onOpen,
  onCancel,
  onSubmit,
  busy,
  error,
  children,
}: {
  label: string;
  disabled?: boolean;
  open: boolean;
  onOpen: () => void;
  onCancel: () => void;
  onSubmit: () => void;
  busy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  if (!open) {
    return (
      <button
        type="button"
        onClick={onOpen}
        disabled={disabled}
        className="mt-1.5 inline-flex items-center gap-1 rounded-lg px-1 py-0.5 text-xs font-semibold text-primary transition-colors hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
      >
        <PlusIcon className="h-3.5 w-3.5" />
        {label}
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-sand-border bg-white/70 p-2.5">
      <div className="grid gap-2">{children}</div>
      {error ? (
        <p className="mt-1.5 text-xs font-medium text-primary" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy}
          className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function QuickAddUnit({
  disabled,
  dimensions,
  onCreate,
}: {
  disabled?: boolean;
  dimensions: UnitDimension[];
  onCreate: (draft: NewUnitDraft) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  // 'count' is the safe default: the units a hotel adds by hand are almost
  // always countable things the seed list does not have (a tuber, a crate).
  const [dimension, setDimension] = useState<UnitDimension>('count');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setCode('');
    setName('');
    setDimension('count');
    setError(null);
  }

  async function submit() {
    const trimmedCode = code.trim();
    const trimmedName = name.trim();
    if (!trimmedCode || !trimmedName) {
      setError('A code and a name are both needed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // rule 11: awaited, in try/catch, and the reason shown right here rather
      // than as a toast the user has to connect back to this box.
      await onCreate({ unitCode: trimmedCode, name: trimmedName, dimension });
      reset();
    } catch (e) {
      setError((e as { message?: string } | null)?.message ?? 'Could not add it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <QuickAddShell
      label="New unit"
      disabled={disabled}
      open={open}
      onOpen={() => setOpen(true)}
      onCancel={reset}
      onSubmit={() => void submit()}
      busy={busy}
      error={error}
    >
      <TextField
        label="Code"
        value={code}
        onChange={setCode}
        placeholder="e.g. crate"
        disabled={busy}
      />
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        placeholder="e.g. Crate"
        disabled={busy}
      />
      <Select
        label="Measures"
        value={dimension}
        onChange={(v) => setDimension(v as UnitDimension)}
        options={dimensions.map((d) => ({
          value: d,
          label: unitDimensionLabel(d),
        }))}
        disabled={busy}
      />
    </QuickAddShell>
  );
}

function QuickAddCategory({
  disabled,
  onCreate,
}: {
  disabled?: boolean;
  onCreate: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setOpen(false);
    setName('');
    setError(null);
  }

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed) {
      setError('A name is needed.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
      reset();
    } catch (e) {
      setError((e as { message?: string } | null)?.message ?? 'Could not add it.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <QuickAddShell
      label="New category"
      disabled={disabled}
      open={open}
      onOpen={() => setOpen(true)}
      onCancel={reset}
      onSubmit={() => void submit()}
      busy={busy}
      error={error}
    >
      <TextField
        label="Name"
        value={name}
        onChange={setName}
        placeholder="e.g. Drinks"
        disabled={busy}
      />
    </QuickAddShell>
  );
}
