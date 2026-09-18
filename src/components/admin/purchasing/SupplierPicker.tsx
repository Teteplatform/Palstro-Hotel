import { useCallback, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { searchSuppliers } from '../../../lib/suppliers';
import type { Supplier } from '../../../types/purchasing';

// CHOOSE ONE SUPPLIER (rule 26) — the searchable picker, wired to the
// server-side supplier search.
//
// ---------------------------------------------------------------------------
// WHY THIS IS A TYPEAHEAD AND NOT A <select>
// ---------------------------------------------------------------------------
// Heledon will have a dozen suppliers on the day it goes live, and a dozen fits
// in a dropdown perfectly well. The rule is about what a selector CAN hold, not
// what today's data does: a hotel that has been trading for two years has two
// hundred, nobody revisits the decision, and the person who would have is
// reading a diff in which a <select> looks fine.
//
// The search is a QUERY against the same predicates the suppliers list uses, so
// the picker's answer and the list's answer cannot disagree — which is the half
// of rule 26 that a client-side filter over a loaded page silently breaks.

interface SupplierPickerProps {
  tenantId: string;
  label?: string;
  value: string;
  // THE ID ONLY. The caller holds the row it needs for other reasons (a name in
  // a heading, a bank detail on a form) and resolves it from the id; handing
  // back a row this component merely searched would mean two sources for the
  // same supplier and a decision about which one wins.
  onChange: (supplierId: string) => void;
  // The chosen row when the caller happens to hold it — used for the label
  // before the user has picked anything this session.
  selectedSupplier?: Supplier | null;
  // Offer only suppliers in use. TRUE on a form about to write something; FALSE
  // on a FILTER, where a switched-off supplier still has orders worth looking at.
  activeOnly?: boolean;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  helpText?: string;
  error?: string;
  placeholder?: string;
}

export function SupplierPicker({
  tenantId,
  label = 'Supplier',
  value,
  onChange,
  selectedSupplier = null,
  activeOnly = true,
  required,
  disabled,
  clearable,
  helpText,
  error,
  placeholder,
}: SupplierPickerProps) {
  // DERIVED, NOT SYNCED — the same decision ItemPicker records. State plus an
  // effect copying the caller's row into it renders one pass with the stale
  // label before the effect catches up, and is a lint error here besides. The
  // caller's row WINS whenever it has one for the current value; the label
  // recorded at pick time is the fallback, kept with the id it belongs to so a
  // value changed from outside can never show the previous pick's name.
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const chosenLabel =
    selectedSupplier && selectedSupplier.id === value
      ? selectedSupplier.name
      : picked && picked.id === value
        ? picked.label
        : null;

  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchSuppliers(tenantId, term, { activeOnly });
      const options: TypeaheadOption[] = result.rows.map((s) => ({
        value: s.id,
        label: s.name,
        // The code first, then who to ask for. Somebody holding a delivery note
        // usually has one of the two rather than the registered name.
        hint: [s.code, s.contact_name].filter(Boolean).join(' · ') || undefined,
        // SHOWN AND EXPLAINED, never filtered out: a row that is absent is
        // indistinguishable from one that does not exist, and the person then
        // cannot tell whether the supplier is missing or merely unavailable here.
        disabled: activeOnly ? false : !s.is_active,
      }));
      return { options, capped: result.capped };
    },
    [tenantId, activeOnly],
  );

  return (
    <Typeahead
      label={label}
      value={value}
      selectedLabel={chosenLabel}
      onChange={(v, option) => {
        setPicked(option ? { id: v, label: option.label } : null);
        onChange(v);
      }}
      search={search}
      required={required}
      disabled={disabled}
      clearable={clearable}
      helpText={helpText}
      error={error}
      placeholder={placeholder ?? 'Search suppliers'}
      emptyMessage="No suppliers match that."
    />
  );
}
