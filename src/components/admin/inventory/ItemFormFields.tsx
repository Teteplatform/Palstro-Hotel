import { NumberField, Select, TextField, Toggle } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import {
  ITEM_TYPES,
  itemTypeHint,
  itemTypeLabel,
} from '../../../lib/inventoryLabels';
import type {
  InventoryCategory,
  ItemType,
  UnitOfMeasure,
} from '../../../types/inventory';

// The item field set, shared by "add an item" and "edit an item" so the two can
// never drift into asking different questions or explaining a choice two
// different ways. Purely presentational: it owns no state and performs no write.
//
// Laid out as a two-column grid that COLLAPSES TO ONE at the sm breakpoint, so
// the whole form is usable at 360px — this is owner/manager setup work that gets
// done on a phone in the store as often as at a desk.

// A UI form shape, not a DB row — the DB row is InventoryItem in types/inventory.
// Fields are the plain values the controls hold: '' for "not set" on text and
// select, null for "no threshold" on the number.
export interface ItemFormValues {
  name: string;
  code: string;
  itemType: ItemType;
  baseUnit: string;
  categoryId: string;
  isPerishable: boolean;
  reorderLevel: number | null;
  isActive: boolean;
}

interface ItemFormFieldsProps {
  values: ItemFormValues;
  onChange: (patch: Partial<ItemFormValues>) => void;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  disabled?: boolean;
  nameError?: string;
  // Edit forms hide the "active" toggle from the create panel, where a new item
  // is always active — a control whose only sensible value is its default is
  // noise on a create form.
  showActive?: boolean;
}

export function ItemFormFields({
  values,
  onChange,
  units,
  categories,
  disabled,
  nameError,
  showActive = true,
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

  // The threshold is measured in the item's own base unit, so the help text says
  // which — "20" means nothing without "kg".
  const unitLabel =
    units.find((u) => u.unit_code === values.baseUnit)?.unit_code ?? 'units';

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
        helpText="A short code for bin cards and stock sheets. Leave blank if you don't use one."
        disabled={disabled}
      />

      <Select
        label="Type"
        required
        value={values.itemType}
        onChange={(v) => onChange({ itemType: v as ItemType })}
        options={typeOptions}
        // The hint follows the CHOICE, so the consequence of the selection is
        // visible at the moment it is made rather than in a legend elsewhere.
        helpText={itemTypeHint(values.itemType)}
        disabled={disabled}
      />

      <Select
        label="Base unit"
        required
        value={values.baseUnit}
        onChange={(v) => onChange({ baseUnit: v })}
        options={unitOptions}
        placeholder={values.baseUnit ? undefined : 'Choose a unit…'}
        helpText="The smallest unit you actually measure and count in. Everything is entered in this unit."
        disabled={disabled}
      />

      <Select
        label="Category"
        value={values.categoryId}
        onChange={(v) => onChange({ categoryId: v })}
        options={categoryOptions}
        helpText="Groups this item in your reports."
        disabled={disabled}
      />

      <NumberField
        label="Reorder level"
        value={values.reorderLevel}
        onChange={(v) => onChange({ reorderLevel: v })}
        min={0}
        step="any"
        placeholder="Optional"
        helpText={`Warn when stock falls below this many ${unitLabel}. Leave blank to not track it.`}
        disabled={disabled}
      />

      <Toggle
        label="Perishable"
        value={values.isPerishable}
        onChange={(v) => onChange({ isPerishable: v })}
        helpText="Goes off with time. Recorded now; expiry and wastage tracking come later."
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
