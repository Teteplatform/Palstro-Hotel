import { useCallback, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { searchExpenseCategories } from '../../../lib/purchasing';
import type { ExpenseCategory } from '../../../types/purchasing';

// CHOOSE AN EXPENSE CATEGORY (1.1h3) — the searchable picker, wired to the
// server-side category search.
//
// ---------------------------------------------------------------------------
// SIX CATEGORIES TODAY. WHY IS THIS NOT A DROPDOWN?
// ---------------------------------------------------------------------------
// The same answer LocationPicker gives, for the same reason: the rule is about
// what a selector CAN hold, not what this tenant's happens to hold this month.
// 052 seeds six, and they are configurable — a hotel that wants one per cost
// centre reaches twenty without anybody revisiting the decision, and the person
// who would have revisited it is reading a diff where a <select> looks fine.
//
// Searching on the server also means the picker's answer and the settings
// list's answer cannot disagree. A box that filtered six loaded rows would
// answer "no matches" for a category that exists the moment there are
// twenty-one of them.
//
// ---------------------------------------------------------------------------
// MATCHED ON NAME AND CODE
// ---------------------------------------------------------------------------
// The code is what somebody who raises orders daily will type — "cleaning"
// rather than "Cleaning and consumables" — and rule 26 asks for both.
//
// ---------------------------------------------------------------------------
// A RETIRED CATEGORY IS NOT OFFERED HERE, AND THAT IS NOT A HIDDEN ROW
// ---------------------------------------------------------------------------
// Rule 26 says a row that exists but cannot be chosen is shown with its reason
// rather than filtered out, because an absent row reads as "we do not have
// one". A RETIRED category is different: it cannot be chosen on a new order at
// all, by any route, so there is nothing to explain at the moment of choosing —
// and the list is of what the hotel currently spends money on. Where it must
// still be visible is on an order already raised against it, and that is what
// 054's deliberately unfiltered join delivers: last March's line still names
// the category, long after it left this picker.

interface ExpenseCategoryPickerProps {
  tenantId: string;
  label?: string;
  // The chosen category's id, or '' for none.
  value: string;
  onChange: (categoryId: string) => void;
  // The chosen row's label when the caller holds it — used before the user
  // picks anything this session, e.g. a line already on a draft order.
  selectedLabel?: string | null;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  helpText?: string;
  error?: string;
  placeholder?: string;
}

export function ExpenseCategoryPicker({
  tenantId,
  label = 'Expense category',
  value,
  onChange,
  selectedLabel = null,
  required,
  disabled,
  clearable,
  helpText,
  error,
  placeholder,
}: ExpenseCategoryPickerProps) {
  // DERIVED, NOT SYNCED — the same shape ItemPicker and LocationPicker use. The
  // caller's label wins when it has one for the CURRENT value; the label
  // recorded at pick time is the fallback, and it is kept with the id it
  // belongs to so a value changed from outside can never show the previous
  // pick's name.
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const chosenLabel =
    selectedLabel && value !== ''
      ? selectedLabel
      : picked && picked.id === value
        ? picked.label
        : null;

  // Stable, so an unrelated field re-rendering the form around this picker does
  // not restart the debounce and fire a redundant query.
  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchExpenseCategories(tenantId, term);
      const options: TypeaheadOption[] = result.rows.map(
        (category: ExpenseCategory) => ({
          value: category.id,
          label: category.name,
          // The code earns its line: it is what the person types, and it is
          // what the chart of accounts and the profit and loss both show.
          hint: category.code,
        }),
      );
      return { options, capped: result.capped };
    },
    [tenantId],
  );

  return (
    <Typeahead
      label={label}
      value={value}
      selectedLabel={chosenLabel}
      onChange={(categoryId, option) => {
        setPicked(option ? { id: categoryId, label: option.label } : null);
        onChange(categoryId);
      }}
      search={search}
      required={required}
      disabled={disabled}
      clearable={clearable}
      helpText={helpText}
      error={error}
      placeholder={placeholder ?? 'Type a category name or code…'}
      emptyMessage="No expense category matches that."
    />
  );
}
