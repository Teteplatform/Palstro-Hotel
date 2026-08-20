import { useCallback, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { searchLocations } from '../../../lib/inventory';
import type { LocationKind, StockLocation } from '../../../types/inventory';
import { locationKindLabel } from '../../../lib/inventoryLabels';

// CHOOSE ONE STOCK LOCATION (1.1e §4) — the searchable picker, wired to the
// server-side location search.
//
// ---------------------------------------------------------------------------
// A HOTEL HAS FOUR LOCATIONS TODAY. WHY IS THIS NOT A DROPDOWN?
// ---------------------------------------------------------------------------
// Because the rule is about what a selector CAN hold, not what this property's
// happens to hold this month. Heledon has a main store, a kitchen and two bars; a
// group with four properties and an outlet in each lounge reaches twenty without
// anybody revisiting the decision, and the person who would have revisited it is
// reading a diff where a <select> looks fine.
//
// The cost of getting it right now is one query per search. The cost of getting it
// wrong is that the day it matters, it matters on a screen somebody is trying to
// work on.
//
// It also makes every picker in the module behave identically — the same box, the
// same arrows, the same Enter — which is worth more than saving one component.
//
// ---------------------------------------------------------------------------
// A CLOSED LOCATION IS SHOWN AS CLOSED, NOT HIDDEN
// ---------------------------------------------------------------------------
// The old Select appended "(closed)" to the label, and that is preserved here as the
// row's second line rather than dropped: a location that is switched off still holds
// stock and still appears in history, and a filter that silently omitted it would
// make its stock unreachable. Forms that must not write into one pass
// `activeOnly` and get a list that genuinely excludes them, server-side.

interface LocationPickerProps {
  tenantId: string;
  propertyId: string;
  label?: string;
  // The chosen location's id, or '' for none.
  value: string;
  // THE ID ONLY — the caller holds the property's locations for other reasons (a
  // name in a heading, the default store) and resolves the row itself.
  onChange: (locationId: string) => void;
  // The chosen row, when the caller holds it — used for the label before the user
  // picks anything this session.
  selectedLocation?: StockLocation | null;
  // Offer only locations that are in use. TRUE for a form about to write a movement;
  // FALSE for a filter over history.
  activeOnly?: boolean;
  // Narrow to one kind, server-side. "Which store issues this" is a question about a
  // subset, and narrowing it after the fact would cap-then-filter.
  kind?: LocationKind;
  required?: boolean;
  disabled?: boolean;
  clearable?: boolean;
  helpText?: string;
  error?: string;
  placeholder?: string;
}

export function LocationPicker({
  tenantId,
  propertyId,
  label = 'Location',
  value,
  onChange,
  selectedLocation = null,
  activeOnly = false,
  kind,
  required,
  disabled,
  clearable,
  helpText,
  error,
  placeholder,
}: LocationPickerProps) {
  // DERIVED, NOT SYNCED — see ItemPicker for the full reasoning. The caller's row
  // wins when it has one for the current value; the label recorded at pick time is
  // the fallback, kept with the id it belongs to so a value changed from outside can
  // never show the previous pick's name.
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);
  const chosenLabel =
    selectedLocation && selectedLocation.id === value
      ? selectedLocation.name
      : picked && picked.id === value
        ? picked.label
        : null;

  // Stable, so an unrelated field re-rendering the form around this picker does not
  // restart the debounce and fire a redundant query — see ItemPicker's note.
  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchLocations(propertyId, tenantId, term, {
        activeOnly,
        kind,
      });
      const options: TypeaheadOption[] = result.rows.map((location) => ({
        value: location.id,
        label: location.name,
        // The kind is behaviour, not decoration (035 §4): a store issues, a kitchen
        // consumes, a bar sells. Worth a line when two locations have similar names.
        hint: location.is_active
          ? locationKindLabel(location.kind)
          : `${locationKindLabel(location.kind)} · closed`,
      }));
      return { options, capped: result.capped };
    },
    [propertyId, tenantId, activeOnly, kind],
  );

  return (
    <Typeahead
      label={label}
      value={value}
      selectedLabel={chosenLabel}
      onChange={(locationId, option) => {
        setPicked(option ? { id: locationId, label: option.label } : null);
        onChange(locationId);
      }}
      search={search}
      required={required}
      disabled={disabled}
      clearable={clearable}
      helpText={helpText}
      error={error}
      placeholder={placeholder ?? 'Type a location name…'}
      emptyMessage="No location matches that name."
    />
  );
}
