import { useCallback, useEffect, useMemo, useState } from 'react';
import { Typeahead, type TypeaheadOption, type TypeaheadResult } from '../../ui/form';
import { TextField, Toggle } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { PlusIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import {
  StickyTablePane,
  STICKY_HEAD_CELL,
} from '../../ui/StickyTable';
import {
  codeIsTaken,
  createChargeCategory,
  fetchAllChargeCategories,
  nextDisplayOrder,
  revenueKeyLabel,
  searchRevenueRoleKeys,
  suggestCode,
  updateChargeCategory,
  type RevenueKeyOption,
} from '../../../lib/chargeCategories';
import { roleKeyLabel } from '../../../lib/accounting';
import type { ChargeCategory } from '../../../types/folio';

// CHARGE CATEGORIES (1.1h4 item 10) — what the hotel may bill for, and which
// revenue account each kind of charge lands in.
//
// WHY IT IS A TAB HERE AND NOT A SCREEN OF ITS OWN: the database chose. 044's
// trigger has refused a category with no account since the day it shipped, and
// its hint reads "Open Settings, then Accounts, and choose the revenue account
// for this category." That named a destination that did not exist. Rule 21 says
// the hint is the interface, so the tab goes where the hint already points
// rather than somewhere that would make the hint wrong.
//
// WHAT WAS ONLY POSSIBLE IN SQL UNTIL NOW. A category is a row, and creating one
// meant typing SQL — which is why 044's guard was correct and inert, and why
// the tracker carried this as a commitment made when the spine shipped.
//
// THE PICKER CHOOSES A ROLE KEY, NOT AN ACCOUNT, and that is not a detail. The
// tab beside this one points each key at an account; this one says which key a
// category uses. Picking "Miscellaneous" without seeing that it resolves to
// "4100 Other revenue" is the silent choice this shipment exists to end, so the
// picker shows both.
//
// NO PREFILL. The field starts empty and every category names where it posts
// explicitly. A default would be revenue landing somewhere nobody chose, which
// is the defect; Miscellaneous survives as a NAMED bucket, offered last, never
// first.

interface ChargeCategoriesTabProps {
  tenantId: string;
  canEdit: boolean;
}

export function ChargeCategoriesTab({ tenantId, canEdit }: ChargeCategoriesTabProps) {
  const toast = useToast();
  const [rows, setRows] = useState<ChargeCategory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  // WHETHER ANY REVENUE KEY IS MAPPED AT ALL. null while unknown, so the empty
  // state cannot flash before the answer arrives.
  const [hasKeys, setHasKeys] = useState<boolean | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError(null);
    void (async () => {
      try {
        const [cats, keys] = await Promise.all([
          fetchAllChargeCategories(tenantId),
          searchRevenueRoleKeys(tenantId, '', { limit: 1 }),
        ]);
        if (!live) return;
        setRows(cats);
        setHasKeys(keys.rows.length > 0);
      } catch (e) {
        if (!live) return;
        setError(humanizeError(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [tenantId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  const search = useCallback(
    async (term: string): Promise<TypeaheadResult> => {
      const result = await searchRevenueRoleKeys(tenantId, term);
      return {
        options: result.rows.map(toOption),
        capped: result.capped,
      };
    },
    [tenantId],
  );

  const handleSave = useCallback(
    async (id: string, patch: Parameters<typeof updateChargeCategory>[1]) => {
      setBusyId(id);
      try {
        await updateChargeCategory(id, patch);
        toast.success('Saved.');
        reload();
      } catch (e) {
        // rule 21: the database's words, verbatim, hint included.
        toast.error(humanizeError(e));
      } finally {
        setBusyId(null);
      }
    },
    [reload, toast],
  );

  return (
    <div className="space-y-4">
      {error !== null && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {rows === null && error === null && (
        <p className="text-sm text-charcoal-muted">Loading…</p>
      )}

      {rows !== null && hasKeys === false && <NoMappedRevenueNotice />}

      {rows !== null && hasKeys !== false && (
        <>
          {canEdit && !adding && (
            <button
              type="button"
              onClick={() => setAdding(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-charcoal px-3 py-1.5 text-sm font-medium text-white"
            >
              <PlusIcon className="h-4 w-4" />
              New category
            </button>
          )}

          {canEdit && adding && (
            <AddChargeCategoryForm
              existing={rows}
              search={search}
              onCancel={() => setAdding(false)}
              onSubmit={async (input) => {
                try {
                  await createChargeCategory({ ...input, tenantId });
                  toast.success(`${input.name} can now be charged.`);
                  setAdding(false);
                  reload();
                } catch (e) {
                  toast.error(humanizeError(e));
                }
              }}
            />
          )}

          <StickyTablePane>
            <table className="w-full min-w-[46rem] border-collapse text-sm">
              <thead>
                <tr>
                  <th className={STICKY_HEAD_CELL}>Category</th>
                  <th className={STICKY_HEAD_CELL}>Posts to</th>
                  <th className={STICKY_HEAD_CELL}>VAT</th>
                  <th className={STICKY_HEAD_CELL}>Service charge</th>
                  <th className={STICKY_HEAD_CELL}>Offered</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-charcoal-muted">
                      No charge categories yet. The first one starts above.
                    </td>
                  </tr>
                )}
                {rows.map((c) => (
                  <ChargeCategoryRow
                    key={c.id}
                    category={c}
                    canEdit={canEdit}
                    busy={busyId === c.id}
                    search={search}
                    onSave={handleSave}
                  />
                ))}
              </tbody>
            </table>
          </StickyTablePane>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function toOption(o: RevenueKeyOption): TypeaheadOption {
  return {
    value: o.roleKey,
    // THE ACCOUNT IS THE PRIMARY LINE because it is what the money does; the
    // role key is the hint because it is what the refusals name. Somebody who
    // has read "Nothing is mapped to revenue_laundry" needs to find that string.
    label: revenueKeyLabel(o),
    hint: o.roleKey,
  };
}

// THE EMPTY STATE THAT NAMES A REMEDY. Reachable on any fresh tenant whose
// chart has no revenue account mapped yet — and an empty picker there would be
// a dead end: nothing to choose, no way to find out why, on the one screen that
// is supposed to explain where money goes.
export function NoMappedRevenueNotice() {
  return (
    <div
      role="status"
      className="rounded-md border border-sand-border bg-sand-subtle px-4 py-3 text-sm text-charcoal"
    >
      <p className="font-medium">No revenue account is mapped yet.</p>
      <p className="mt-1 text-charcoal-muted">
        A charge category has to name the revenue account its charges land in, so
        there is nothing to choose from until at least one is mapped. Open{' '}
        <strong>Where money posts</strong>, the tab beside this one, and point a
        revenue key at an account on your chart.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ChargeCategoryRowProps {
  category: ChargeCategory;
  canEdit: boolean;
  busy: boolean;
  search: (term: string) => Promise<TypeaheadResult>;
  onSave: (id: string, patch: Parameters<typeof updateChargeCategory>[1]) => void;
}

// ONE ROW, AND THE SEAM THE RENDER PROOF DRIVES. Everything decided here is
// invisible to SQL: which label a key shows, whether a retired category still
// says where it posts, and whether an unmapped key reads as a warning or as a
// blank cell that looks like a loading state.
export function ChargeCategoryRow({
  category,
  canEdit,
  busy,
  search,
  onSave,
}: ChargeCategoryRowProps) {
  const [editingName, setEditingName] = useState(false);
  const [draft, setDraft] = useState(category.name);

  return (
    <tr className="border-t border-sand-border align-top">
      <td className="px-3 py-2">
        {canEdit && editingName ? (
          <div className="flex items-center gap-2">
            <TextField
              label={`Name of ${category.code}`}
              value={draft}
              onChange={setDraft}
              disabled={busy}
            />
            <button
              type="button"
              className="text-sm underline"
              disabled={busy || draft.trim() === ''}
              onClick={() => {
                setEditingName(false);
                if (draft.trim() !== category.name) onSave(category.id, { name: draft.trim() });
              }}
            >
              Save
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="text-left"
            disabled={!canEdit}
            onClick={() => {
              setDraft(category.name);
              setEditingName(true);
            }}
          >
            <span className="font-medium text-charcoal">{category.name}</span>
            <br />
            {/* THE CODE IS SHOWN AND NEVER EDITABLE. Modules post against it and
                charges already carry it; renaming it would repoint history. */}
            <code className="text-[11px] text-charcoal-muted">{category.code}</code>
          </button>
        )}
      </td>

      <td className="px-3 py-2">
        {canEdit ? (
          <Typeahead
            label={`Revenue account for ${category.name}`}
            value={category.account_role_key}
            // THE CHOSEN KEY'S LABEL IS OWNED HERE, not read from the search
            // result — the chosen row is usually not in the current result, and
            // a picker that blanks its own value while you type has lost the
            // one thing it was showing.
            selectedLabel={roleKeyLabel(category.account_role_key)}
            onChange={(value) => {
              if (value && value !== category.account_role_key) {
                onSave(category.id, { accountRoleKey: value });
              }
            }}
            search={search}
            emptyMessage="No revenue account matches that."
            disabled={busy}
          />
        ) : (
          <>
            <span className="text-charcoal">{roleKeyLabel(category.account_role_key)}</span>
            <br />
            <code className="text-[11px] text-charcoal-muted">
              {category.account_role_key}
            </code>
          </>
        )}
      </td>

      <td className="px-3 py-2">
        <Toggle
          label={`VAT on ${category.name}`}
          value={category.is_taxable}
          onChange={(v) => onSave(category.id, { isTaxable: v })}
          disabled={!canEdit || busy}
        />
      </td>

      <td className="px-3 py-2">
        <Toggle
          label={`Service charge on ${category.name}`}
          value={category.service_chargeable}
          onChange={(v) => onSave(category.id, { serviceChargeable: v })}
          disabled={!canEdit || busy}
        />
      </td>

      <td className="px-3 py-2">
        {/* RETIRING IS NOT DELETING (rule 5 / §6). A category switched off stops
            being offered at the desk and stays on every charge that used it, so
            past bills and reports still read the same. */}
        <Toggle
          label={`Offer ${category.name} at the desk`}
          value={category.is_active}
          onChange={(v) => onSave(category.id, { isActive: v })}
          disabled={!canEdit || busy}
        />
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

interface AddChargeCategoryFormProps {
  existing: ChargeCategory[];
  search: (term: string) => Promise<TypeaheadResult>;
  onCancel: () => void;
  onSubmit: (input: {
    code: string;
    name: string;
    isTaxable: boolean;
    serviceChargeable: boolean;
    accountRoleKey: string;
    displayOrder: number;
  }) => Promise<void>;
}

export function AddChargeCategoryForm({
  existing,
  search,
  onCancel,
  onSubmit,
}: AddChargeCategoryFormProps) {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [touchedCode, setTouchedCode] = useState(false);
  // NO PREFILL. Empty until a person chooses (the header says why).
  const [roleKey, setRoleKey] = useState('');
  const [roleKeyLabelText, setRoleKeyLabelText] = useState<string | null>(null);
  const [taxable, setTaxable] = useState(true);
  const [serviceChargeable, setServiceChargeable] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const effectiveCode = touchedCode ? code : suggestCode(name);
  const taken = effectiveCode !== '' && codeIsTaken(existing, effectiveCode);
  const canSubmit =
    name.trim() !== '' && effectiveCode !== '' && !taken && roleKey !== '' && !submitting;

  const order = useMemo(() => nextDisplayOrder(existing), [existing]);

  return (
    <form
      className="space-y-3 rounded-md border border-sand-border p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSubmit) return;
        setSubmitting(true);
        void onSubmit({
          code: effectiveCode,
          name: name.trim(),
          isTaxable: taxable,
          serviceChargeable: serviceChargeable,
          accountRoleKey: roleKey,
          displayOrder: order,
        }).finally(() => setSubmitting(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" required value={name} onChange={setName} disabled={submitting} />
        <TextField
          label="Code"
          required
          value={effectiveCode}
          onChange={(v) => {
            setTouchedCode(true);
            setCode(v);
          }}
          disabled={submitting}
          error={taken ? 'A category already uses that code.' : undefined}
          // THIS HINT EARNS ITS PLACE (rule 25): the label cannot carry it, and
          // somebody about to type over a suggestion needs to know it is
          // permanent before they do, not after.
          helpText="Set once and never changed — charges keep it, so renaming it later would repoint them."
        />
      </div>

      <Typeahead
        label="Revenue account"
        required
        value={roleKey}
        selectedLabel={roleKeyLabelText}
        onChange={(value, option) => {
          setRoleKey(value);
          setRoleKeyLabelText(option?.label ?? null);
        }}
        search={search}
        placeholder="Choose where these charges post"
        emptyMessage="No revenue account matches that."
        disabled={submitting}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle label="VAT applies" value={taxable} onChange={setTaxable} disabled={submitting} />
        <Toggle
          label="Service charge applies"
          value={serviceChargeable}
          onChange={setServiceChargeable}
          disabled={submitting}
        />
      </div>

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={!canSubmit}
          className="rounded-md bg-charcoal px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Add category'}
        </button>
        <button type="button" onClick={onCancel} className="px-3 py-1.5 text-sm underline">
          Cancel
        </button>
      </div>
    </form>
  );
}
