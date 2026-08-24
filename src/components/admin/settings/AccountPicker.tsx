import { useCallback, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { accountLabel, searchAccounts } from '../../../lib/accounting';


// THE ACCOUNT PICKER (rule 26). One primitive owns the behaviour, this wrapper
// owns the query.
//
// WHY IT IS A TYPEAHEAD AND NOT A <select>, when a seeded chart has thirty-five
// rows. Rule 26's threshold is what a selector CAN hold, not what today's data
// does: a hotel group with an outlet in every lounge and a real accountant's
// chart reaches three hundred accounts without anybody revisiting the decision,
// and the person who would have revisited it is reading a diff where a <select>
// looks fine. The search is a SERVER query using the same predicates
// fetchAllAccounts uses, so the picker and the list can never disagree.
//
// AN INACTIVE ACCOUNT IS SHOWN AND DISABLED, never filtered out. resolve_account
// refuses to post through a deactivated account, so offering one would be a trap
// — but dropping it is worse: an absent row is indistinguishable from an account
// that does not exist, and somebody who deactivated "Petty cash" last month and
// is now looking for it would conclude the chart never had it. Shown, with the
// reason, is the honest version.

interface AccountPickerProps {
  label: string;
  value: string;
  // The chosen account's label, held by the caller: the chosen row is usually
  // not in the current search result (Typeahead's header explains why).
  selectedLabel: string | null;
  onChange: (accountId: string) => void;
  tenantId: string;
  disabled?: boolean;
  helpText?: string;
  error?: string;
}

export function AccountPicker({
  label,
  value,
  selectedLabel,
  onChange,
  tenantId,
  disabled,
  helpText,
  error,
}: AccountPickerProps) {
  const [picked, setPicked] = useState<{ id: string; label: string } | null>(null);

  const chosenLabel =
    picked && picked.id === value ? picked.label : selectedLabel;

  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchAccounts(tenantId, term);
      const options: TypeaheadOption[] = result.rows.map((account) => ({
        value: account.id,
        label: accountLabel(account),
        // The reason replaces the type when there is one: why this row cannot be
        // chosen matters more than what kind of account it is.
        hint: account.is_active
          ? account.account_type
          : 'Switched off — turn it back on in the chart of accounts first',
        disabled: !account.is_active,
      }));
      return { options, capped: result.capped };
    },
    [tenantId],
  );

  return (
    <Typeahead
      label={label}
      value={value}
      selectedLabel={chosenLabel}
      onChange={(accountId, option) => {
        setPicked(option ? { id: accountId, label: option.label } : null);
        onChange(accountId);
      }}
      search={search}
      disabled={disabled}
      helpText={helpText}
      error={error}
      placeholder="Type an account name or number…"
      emptyMessage="No account matches that name or number."
    />
  );
}
