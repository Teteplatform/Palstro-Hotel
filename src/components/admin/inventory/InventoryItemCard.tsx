import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { ChevronDownIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import { updateInventoryItem } from '../../../lib/inventory';
import { formatQuantity, MISSING_VALUE, parseNumeric } from '../../../lib/format';
import { itemTypeLabel, itemTypeTone } from '../../../lib/inventoryLabels';
import { ItemFormFields, type ItemFormValues } from './ItemFormFields';
import type {
  InventoryCategory,
  InventoryItem,
  UnitOfMeasure,
} from '../../../types/inventory';

// One catalogue item as a collapsible card: a summary row that is always
// visible, and an expandable body carrying the editable fields. The same
// pattern as CompanyEditor/RoomTypeEditor — a card list reads correctly at
// 360px where a wide table would not, while still showing every column the
// brief asks for (name, code, type, base unit, category, reorder level, active).

interface InventoryItemCardProps {
  item: InventoryItem;
  tenantId: string;
  units: UnitOfMeasure[];
  categories: InventoryCategory[];
  onUpdated: (row: InventoryItem) => void;
  onRequestDelete: (item: InventoryItem) => void;
  busyRow: boolean;
}

export function InventoryItemCard({
  item,
  tenantId,
  units,
  categories,
  onUpdated,
  onRequestDelete,
  busyRow,
}: InventoryItemCardProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nameError, setNameError] = useState<string | undefined>();

  // Editable state seeded from the row. reorder_level is a numeric column and
  // therefore arrives as a STRING (§6) — parse it explicitly; never rely on
  // coercion.
  const [values, setValues] = useState<ItemFormValues>(() => toForm(item));

  // Re-seed when the row changes from OUTSIDE (a reload after a save elsewhere)
  // via React's adjust-state-on-prop-change pattern — a conditional setState in
  // render, not an effect, matching the form primitives.
  const [lastItem, setLastItem] = useState(item);
  if (item !== lastItem) {
    setLastItem(item);
    setValues(toForm(item));
    setNameError(undefined);
  }

  function patch(next: Partial<ItemFormValues>) {
    setValues((prev) => ({ ...prev, ...next }));
    if (next.name !== undefined) setNameError(undefined);
  }

  async function handleSave() {
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
      const row = await updateInventoryItem(item.id, tenantId, {
        name: values.name.trim(),
        code: values.code.trim() || null,
        item_type: values.itemType,
        base_unit: values.baseUnit,
        category_id: values.categoryId || null,
        is_perishable: values.isPerishable,
        reorder_level: values.reorderLevel,
        is_active: values.isActive,
      });
      onUpdated(row);
      toast.success('Item saved.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  const categoryName =
    categories.find((c) => c.id === item.category_id)?.name ?? null;

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      {/* Summary row — everything the list must show, without expanding. */}
      <div className="flex flex-wrap items-start justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-start gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <ChevronDownIcon
            className={`mt-0.5 h-5 w-5 shrink-0 text-charcoal-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold text-charcoal">
                {item.name}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${itemTypeTone(item.item_type)}`}
              >
                {itemTypeLabel(item.item_type)}
              </span>
              {!item.is_active ? (
                <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                  Not in use
                </span>
              ) : null}
              {item.is_perishable ? (
                <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                  Perishable
                </span>
              ) : null}
            </span>
            {/* The remaining columns, as a wrapping meta line so nothing is
                lost on a narrow screen and nothing overflows. */}
            <span className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-charcoal-muted">
              <span>Unit: {item.base_unit}</span>
              <span>Category: {categoryName ?? MISSING_VALUE}</span>
              <span>Code: {item.code || MISSING_VALUE}</span>
              <span>
                Reorder at:{' '}
                {item.reorder_level === null
                  ? MISSING_VALUE
                  : `${formatQuantity(item.reorder_level)} ${item.base_unit}`}
              </span>
            </span>
          </span>
        </button>

        <button
          type="button"
          onClick={() => onRequestDelete(item)}
          disabled={busyRow || saving}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Remove
        </button>
      </div>

      {expanded ? (
        <div className="border-t border-sand-border p-4">
          <ItemFormFields
            values={values}
            onChange={patch}
            units={units}
            categories={categories}
            disabled={saving}
            nameError={nameError}
          />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {saving ? 'Saving…' : 'Save item'}
            </button>
            <button
              type="button"
              onClick={() => {
                setValues(toForm(item));
                setNameError(undefined);
              }}
              disabled={saving}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Discard changes
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// Row -> form values. reorder_level is numeric(14,4) and arrives as a string
// (§6); parseNumeric turns it into a number or null and never a silent 0.
function toForm(item: InventoryItem): ItemFormValues {
  return {
    name: item.name,
    code: item.code ?? '',
    itemType: item.item_type,
    baseUnit: item.base_unit,
    categoryId: item.category_id ?? '',
    isPerishable: item.is_perishable,
    reorderLevel: parseNumeric(item.reorder_level),
    isActive: item.is_active,
  };
}
