import { useCallback, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { searchInventoryItems } from '../../../lib/inventory';
import type { InventoryItem } from '../../../types/inventory';

// CHOOSE ONE CATALOGUE ITEM (1.1e §4) — the searchable picker, wired to the
// server-side item search.
//
// ---------------------------------------------------------------------------
// WHY THIS WRAPPER EXISTS RATHER THAN EACH FORM CALLING Typeahead
// ---------------------------------------------------------------------------
// Three surfaces pick an item: the adjustment/opening form, the movements filter,
// and whatever comes next. Each of them needs the same four decisions made the same
// way — which items are offered (live, and active unless asked otherwise), what the
// second line of a row says (the code, so a storekeeper with bin cards can find it),
// how a chosen item is labelled once the search box has been cleared, and what
// happens to items that exist but cannot be chosen here. Made three times, they
// would be made three different ways.
//
// ---------------------------------------------------------------------------
// THE SEARCH IS THE SERVER'S, ALWAYS
// ---------------------------------------------------------------------------
// searchInventoryItems queries inventory_items with the same predicates the
// products list uses. The screens that host this DO also hold a loaded catalogue
// (for unit labels and row names), and it would have been one line to filter that
// array instead — which is exactly the mistake the rule names: a filter over a
// loaded array searches what was fetched, and the day that array becomes a page
// rather than the whole catalogue, the picker starts lying and nothing errors.
// Going to the server means the picker's answer cannot drift from the list's.
//
// ---------------------------------------------------------------------------
// AN ITEM THAT CANNOT BE CHOSEN IS SHOWN AND EXPLAINED, NOT HIDDEN
// ---------------------------------------------------------------------------
// The opening-balance form must not offer an item that already has one in this
// location. It used to drop those from the list, and dropping them has two costs:
// the storekeeper searches for "Rice", finds nothing, and cannot tell whether the
// item is missing or merely unavailable here — and, once the search moved to the
// server, filtering the RESULT would mean a query returning twenty rows could show
// two, which reads as "no matches" for a term that matched twenty things.
//
// So `unavailable` returns a REASON, the row is listed with it, and it cannot be
// selected. The person sees that Rice exists, sees why it is not on offer, and knows
// the correction they want is an adjustment.

interface ItemPickerProps {
  tenantId: string;
  label?: string;
  // The chosen item's id, or '' for none.
  value: string;
  // THE ID ONLY. Every caller already holds the catalogue for other reasons (a unit
  // label, a row name) and resolves the row from the id itself; handing back a row
  // this component has merely searched would mean two sources for the same item and
  // a decision about which one wins.
  onChange: (itemId: string) => void;
  // The chosen row, when the caller happens to hold it — used for the label before
  // the user has picked anything this session (an edit form opening on an existing
  // choice). After a pick, this component knows the label itself.
  selectedItem?: InventoryItem | null;
  // Offer only items that are in use. TRUE for a form that is about to write
  // something; FALSE for a filter, where a switched-off item still has history
  // worth looking at.
  activeOnly?: boolean;
  // Why this item cannot be chosen here, or null when it can. Returned as a
  // SENTENCE, because it is shown on the row.
  unavailable?: (item: InventoryItem) => string | null;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  helpText?: string;
  error?: string;
  placeholder?: string;
}

export function ItemPicker({
  tenantId,
  label = 'Item',
  value,
  onChange,
  selectedItem = null,
  activeOnly = true,
  unavailable,
  required,
  disabled,
  clearable,
  helpText,
  error,
  placeholder,
}: ItemPickerProps) {
  // WHAT THE CHOSEN ITEM IS CALLED. After a pick the item may be in no later search
  // result (the box has been cleared, or something else typed), so the label cannot
  // come from the options — see Typeahead's header.
  //
  // DERIVED, NOT SYNCED. The obvious shape is state plus an effect that copies the
  // caller's row into it, and that shape is both a lint error here and a real bug:
  // it renders one pass with the stale label before the effect catches up. So the
  // caller's row WINS whenever it has one for the current value, and the label
  // recorded at pick time is the fallback — kept with the id it belongs to, so a
  // value changed from outside can never show the previous pick's name.
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const chosenLabel =
    selectedItem && selectedItem.id === value
      ? itemLabel(selectedItem)
      : picked && picked.id === value
        ? picked.label
        : null;

  // Stable, so an unrelated field re-rendering the form around this picker does not
  // restart the debounce and fire a redundant query. NOT what makes the search
  // correct — proofs/pickerRender §4 of its header records the breakage that showed
  // so, because `term` lives inside Typeahead and a parent does not re-render per
  // keystroke. Kept for the redundant-query case, which is real.
  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchInventoryItems(tenantId, term, { activeOnly });
      const options: TypeaheadOption[] = result.rows.map((item) => {
        const reason = unavailable?.(item) ?? null;
        return {
          value: item.id,
          label: item.name,
          // The code first, because that is what somebody holding a bin card is
          // matching. The reason replaces it when there is one: why this row cannot
          // be used matters more than its code.
          hint: reason ?? itemHint(item),
          disabled: Boolean(reason),
        };
      });
      return { options, capped: result.capped };
    },
    [tenantId, activeOnly, unavailable],
  );

  return (
    <Typeahead
      label={label}
      value={value}
      selectedLabel={chosenLabel}
      onChange={(itemId, option) => {
        setPicked(option ? { id: itemId, label: option.label } : null);
        onChange(itemId);
      }}
      search={search}
      required={required}
      disabled={disabled}
      clearable={clearable}
      helpText={helpText}
      error={error}
      placeholder={placeholder ?? 'Type an item name or code…'}
      emptyMessage="No item matches that name or code."
    />
  );
}

function itemLabel(item: InventoryItem): string {
  return item.name;
}

function itemHint(item: InventoryItem): string {
  const parts = [item.code, `tracked in ${item.base_unit}`].filter(Boolean);
  return parts.join(' · ');
}
