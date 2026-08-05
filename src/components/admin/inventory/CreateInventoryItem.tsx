import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import { createInventoryItem } from '../../../lib/inventory';
import { ItemFormFields, type ItemFormValues } from './ItemFormFields';
import type {
  InventoryCategory,
  InventoryItem,
  UnitOfMeasure,
} from '../../../types/inventory';

// The blank form a new item starts from. Module-local (not exported) because
// this is the only surface that starts from blank — the edit card seeds from its
// row — and because a component file that also exports a constant breaks fast
// refresh (the codebase's react-refresh rule).
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

// Add a catalogue item. Admin-gated at the DB (035's is_tenant_admin insert
// policy is the real guard, rule 19); this panel is only the affordance.
//
// Rule 11: the write is awaited inside try/catch and any failure is surfaced as
// a toast — never a fire-and-forget promise, never a swallowed error.

interface CreateInventoryItemProps {
  tenantId: string;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  // Distinguishes "the reference data has not arrived yet" from "this tenant
  // genuinely has no units" — the two need opposite messages, and telling
  // somebody their units are missing while they are still loading would send
  // them looking for a problem that does not exist.
  referenceLoading: boolean;
  onCreated: (row: InventoryItem) => void;
}

export function CreateInventoryItem({
  tenantId,
  units,
  categories,
  referenceLoading,
  onCreated,
}: CreateInventoryItemProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<ItemFormValues>(EMPTY_ITEM_FORM);
  const [nameError, setNameError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  function patch(next: Partial<ItemFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
    if (next.name !== undefined) setNameError(undefined);
  }

  function reset() {
    setValues(EMPTY_ITEM_FORM);
    setNameError(undefined);
  }

  async function handleCreate() {
    if (!values.name.trim()) {
      setNameError('An item name is required.');
      return;
    }
    if (!values.baseUnit) {
      toast.error('Choose the unit this item is measured in.');
      return;
    }
    setSaving(true);
    try {
      const row = await createInventoryItem(tenantId, {
        name: values.name.trim(),
        code: values.code.trim() || null,
        item_type: values.itemType,
        base_unit: values.baseUnit,
        category_id: values.categoryId || null,
        is_perishable: values.isPerishable,
        reorder_level: values.reorderLevel,
        is_active: true,
        // The catalogue lists alphabetically (see fetchInventoryItemsPage), so a
        // new item needs no position — display_order is reserved for later
        // curated groupings and stays at its default.
        display_order: 0,
      });
      onCreated(row);
      toast.success('Item added.');
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  // Units are seeded per tenant (035 §5) precisely so this can never be a dead
  // end, but if a tenant has somehow retired every unit, say so plainly rather
  // than offering a form that cannot be submitted.
  const noUnits = !referenceLoading && units.length === 0;
  const blocked = noUnits || referenceLoading;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
      >
        <PlusIcon className="h-4 w-4" />
        Add item
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="mb-3 text-base font-semibold text-charcoal">New item</h2>

      {referenceLoading ? (
        <p
          className="mb-3 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted"
          aria-live="polite"
        >
          Loading units and categories…
        </p>
      ) : noUnits ? (
        <p className="mb-3 rounded-xl border border-sand-border bg-white/60 p-3 text-sm text-charcoal-muted">
          There are no units of measure set up, so an item cannot be created yet.
        </p>
      ) : null}

      <ItemFormFields
        values={values}
        onChange={patch}
        units={units}
        categories={categories}
        disabled={saving || blocked}
        nameError={nameError}
        showActive={false}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={saving || blocked}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          {saving ? 'Adding…' : 'Add item'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={saving}
          className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
