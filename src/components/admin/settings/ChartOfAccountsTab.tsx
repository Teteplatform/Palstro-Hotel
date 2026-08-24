import { useCallback, useEffect, useMemo, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { PlusIcon, SearchIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import {
  StickyTablePane,
  STICKY_GROUP_CELL,
  STICKY_HEAD_CELL,
} from '../../ui/StickyTable';
import { fetchAllAccounts } from '../../../lib/accounting';
import {
  CHART_SECTIONS,
  chartSection,
  codeIsInSection,
  codeIsTaken,
  createAccount,
  filterChart,
  groupChart,
  suggestNextCode,
  updateAccount,
  type ChartGroup,
} from '../../../lib/chartOfAccounts';
import type { Account, AccountType } from '../../../types/accounting';

// THE CHART OF ACCOUNTS (1.1h1) — the list an accountant opens first.
//
// TWO DIFFERENT OBJECTS, and 1.1h shipped only one of them. This is THE LIST:
// 1000 Cash, 1010 Bank, 4000 Room revenue, grouped the way a financial statement
// is grouped. The "Where money posts" tab beside it is the role-key mapping —
// correct, and secondary. A trial balance is just this list with balances on it,
// so if the list is wrong every statement built on it is wrong.
//
// DENSE ON PURPOSE. No cards, no per-row help, no dropdown per line. The row IS
// the data. This is the one screen in the admin that should read like a
// spreadsheet, because that is the document it stands in for.
//
// CODES ARE RIGHT-ALIGNED AND TABULAR. `tabular-nums` makes 1000 and 1010 line
// up as a column of numbers rather than a ragged column of text, which is the
// difference between scanning a chart and reading it.
//
// NO PAGINATION, and that is not an oversight of rule 1b. Rule 1b exists because
// a hard cap with no pager makes older rows silently unreachable. fetchAllAccounts
// pages internally until the rows run out, so nothing is capped and there is
// never a second page — a pager here would be furniture. Search filters the
// whole set for the same reason (see chartSearchMatches).

interface ChartOfAccountsTabProps {
  tenantId: string;
  canEdit: boolean;
}

export function ChartOfAccountsTab({ tenantId, canEdit }: ChartOfAccountsTabProps) {
  const toast = useToast();
  const [rows, setRows] = useState<Account[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const data = await fetchAllAccounts(tenantId);
        if (cancelled) return;
        setRows(data);
        setError(null);
      } catch (e) {
        if (!cancelled) {
          setError(humanizeError(e));
          setRows(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, nonce]);

  const groups: ChartGroup[] = useMemo(
    () => (rows ? groupChart(filterChart(rows, search)) : []),
    [rows, search],
  );

  const filtering = search.trim() !== '';
  const shown = groups.reduce((n, g) => n + g.rows.length, 0);

  async function saveNew(input: {
    name: string;
    account_type: AccountType;
    code: string;
    is_active: boolean;
  }) {
    try {
      await createAccount(tenantId, input);
      setAdding(false);
      setSearch('');
      reload();
      toast.success(`${input.code} ${input.name} added.`);
    } catch (e) {
      // Rule 21: the database's words. accounts_code_uniq speaks for itself.
      toast.error(humanizeError(e));
    }
  }

  async function toggleActive(account: Account) {
    try {
      await updateAccount(account.id, { is_active: !account.is_active });
      reload();
      toast.success(
        account.is_active
          ? `${account.code} switched off.`
          : `${account.code} switched back on.`,
      );
    } catch (e) {
      // 045's trigger refuses a deactivation while a mapping still points here,
      // and names the role key in its hint. Rendered verbatim.
      toast.error(humanizeError(e));
    }
  }

  async function rename(account: Account, name: string) {
    const next = name.trim();
    if (next === '' || next === account.name) return;
    try {
      await updateAccount(account.id, { name: next });
      reload();
    } catch (e) {
      toast.error(humanizeError(e));
    }
  }

  return (
    <div>
      {error && (
        <p
          role="alert"
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </p>
      )}

      {/* Search and the one action, on a single row — the ProductsTab shape. */}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-[14rem] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-charcoal-muted" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by number or name…"
            aria-label="Search the chart of accounts"
            className="w-full rounded-lg border border-sand-border bg-white/70 py-2 pl-9 pr-3 text-sm text-charcoal placeholder:text-charcoal-muted focus:border-primary focus:outline-none"
          />
        </div>
        {canEdit && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="inline-flex items-center gap-2 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            <PlusIcon className="h-4 w-4" />
            Add account
          </button>
        )}
      </div>

      {adding && rows && (
        <AddAccountForm
          existing={rows}
          onCancel={() => setAdding(false)}
          onSave={saveNew}
        />
      )}

      {rows === null && !error && (
        <p className="text-sm text-charcoal-muted">Loading…</p>
      )}

      {rows !== null && shown === 0 && (
        <EmptyState filtering={filtering} onClear={() => setSearch('')} />
      )}

      {shown > 0 && (
        <StickyTablePane>
          <table className="w-full min-w-[34rem] border-collapse text-sm">
            <thead>
              {/* STICKY ON EACH <th>, NEVER ON THE <tr> — Safari has
                  historically not laid out a sticky table row, and the failure
                  is invisible on the machine you built it on. `top-0` because
                  StickyTablePane is the scroll context, not the page; the
                  section headings below sit exactly one header-row lower, which
                  is why STICKY_HEAD_CELL carries an explicit height. Both are
                  measured, not guessed — see StickyTable's header. */}
              <tr className="border-b border-sand-border text-left">
                <th className={`${STICKY_HEAD_CELL} w-24 px-3 text-right`}>
                  Number
                </th>
                <th className={`${STICKY_HEAD_CELL} px-3 text-left`}>Name</th>
                <th className={`${STICKY_HEAD_CELL} w-28 px-3 text-left`}>
                  Status
                </th>
                {canEdit && (
                  <th className={`${STICKY_HEAD_CELL} w-24 px-3 text-right`}>
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>

            {groups.map((group) => (
              <tbody key={group.section.type} className="divide-y divide-sand-border/50">
                <tr>
                  <th
                    colSpan={canEdit ? 4 : 3}
                    scope="colgroup"
                    className={STICKY_GROUP_CELL}
                  >
                    {group.section.label}
                    {/* A COUNT, NOT A TOTAL. Money arrives with the trial
                        balance; counting the rows is the only sum this screen
                        can make honestly today. */}
                    <span className="ml-2 font-normal normal-case tracking-normal text-charcoal-muted">
                      {group.rows.length}
                      {group.rows.length === 1 ? ' account' : ' accounts'}
                    </span>
                  </th>
                </tr>
                {group.rows.map((account) => (
                  <AccountRow
                    key={account.id}
                    account={account}
                    canEdit={canEdit}
                    onRename={(name) => void rename(account, name)}
                    onToggle={() => void toggleActive(account)}
                  />
                ))}
              </tbody>
            ))}
          </table>
        </StickyTablePane>
      )}

      {filtering && shown > 0 && (
        <p className="mt-2 text-xs text-charcoal-muted">
          {shown} of {rows?.length ?? 0} accounts match “{search.trim()}”.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

export function AccountRow({
  account,
  canEdit,
  onRename,
  onToggle,
}: {
  account: Account;
  canEdit: boolean;
  onRename: (name: string) => void;
  onToggle: () => void;
}) {
  const [draft, setDraft] = useState(account.name);
  const [editing, setEditing] = useState(false);

  return (
    <tr className={account.is_active ? '' : 'text-charcoal-muted'}>
      {/* RIGHT-ALIGNED AND TABULAR: a column of numbers, not of text. */}
      <td className="px-3 py-1.5 text-right font-medium tabular-nums text-charcoal">
        {account.code}
      </td>
      <td className="px-3 py-1.5">
        {editing && canEdit ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              setEditing(false);
              onRename(draft);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                setEditing(false);
                onRename(draft);
              }
              if (e.key === 'Escape') {
                setDraft(account.name);
                setEditing(false);
              }
            }}
            aria-label={`Name of account ${account.code}`}
            className="w-full rounded border border-primary bg-white px-1.5 py-0.5 text-sm text-charcoal focus:outline-none"
          />
        ) : canEdit ? (
          // RENAMING IS ALWAYS ALLOWED — 045 freezes the code once posted and
          // never the name. Click-to-edit rather than a form, because correcting
          // "Bank" to "GTBank current" should cost one click.
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="w-full rounded px-1.5 py-0.5 text-left hover:bg-sand/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {account.name}
          </button>
        ) : (
          <span className="px-1.5">{account.name}</span>
        )}
      </td>
      <td className="px-3 py-1.5">
        {account.is_active ? (
          <span className="text-charcoal-muted">Active</span>
        ) : (
          <span className="rounded bg-sand px-1.5 py-0.5 text-xs font-medium text-charcoal">
            Switched off
          </span>
        )}
      </td>
      {canEdit && (
        <td className="px-3 py-1.5 text-right">
          <button
            type="button"
            onClick={onToggle}
            className="text-xs font-semibold text-charcoal underline underline-offset-2 hover:text-primary"
          >
            {account.is_active ? 'Switch off' : 'Switch on'}
          </button>
        </td>
      )}
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Add account
// ---------------------------------------------------------------------------
// Four fields, as specified: name, group, code, active. Nothing else — no note,
// no description, no ordering. The code is SUGGESTED and the form says which
// range it is suggesting within, so nobody has to know that a liability starts
// with 2.

export function AddAccountForm({
  existing,
  onCancel,
  onSave,
}: {
  existing: Pick<Account, 'code' | 'account_type'>[];
  onCancel: () => void;
  onSave: (input: {
    name: string;
    account_type: AccountType;
    code: string;
    is_active: boolean;
  }) => void;
}) {
  const [type, setType] = useState<AccountType>('asset');
  const [name, setName] = useState('');
  // The suggestion is the INITIAL value, not a controlled echo — once somebody
  // types their own number, changing the group must not silently overwrite it.
  const [code, setCode] = useState(() => suggestNextCode(existing, 'asset'));
  const [touchedCode, setTouchedCode] = useState(false);
  const [active, setActive] = useState(true);

  const section = chartSection(type);

  function pickType(next: AccountType) {
    setType(next);
    if (!touchedCode) setCode(suggestNextCode(existing, next));
  }

  const taken = codeIsTaken(existing, code);
  const outOfRange = code.trim() !== '' && !codeIsInSection(code, type);
  const canSave = name.trim() !== '' && code.trim() !== '' && !taken;

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (!canSave) return;
        onSave({ name, account_type: type, code, is_active: active });
      }}
      className="mb-4 rounded-2xl border border-sand-border bg-white/70 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr_7rem]">
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-charcoal-muted">Group</span>
          <select
            value={type}
            onChange={(e) => pickType(e.target.value as AccountType)}
            className="w-full rounded-lg border border-sand-border bg-white px-2 py-2 text-sm text-charcoal focus:border-primary focus:outline-none"
          >
            {CHART_SECTIONS.map((s) => (
              <option key={s.type} value={s.type}>
                {s.label}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-charcoal-muted">Name</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. GTBank current account"
            className="w-full rounded-lg border border-sand-border bg-white px-2 py-2 text-sm text-charcoal focus:border-primary focus:outline-none"
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-charcoal-muted">Number</span>
          <input
            value={code}
            inputMode="numeric"
            onChange={(e) => {
              setTouchedCode(true);
              setCode(e.target.value);
            }}
            className="w-full rounded-lg border border-sand-border bg-white px-2 py-2 text-right text-sm tabular-nums text-charcoal focus:border-primary focus:outline-none"
          />
        </label>
      </div>

      {/* THE RANGE, SAID OUT LOUD. Not a tooltip: it is the one fact somebody
          needs at the moment they are choosing, and it changes with the group. */}
      <p className="mt-2 text-xs text-charcoal-muted">
        {section.label} run from {section.rangeStart} to {section.rangeEnd}.
      </p>

      {/* Both of these appear only when they are true — a live consequence, not
          teaching (rule 25). The duplicate check says so BEFORE the save fails;
          accounts_code_uniq is still what actually holds. */}
      {taken && (
        <p className="mt-1 text-xs text-red-700">
          {code.trim()} is already used by another account. Pick a different number.
        </p>
      )}
      {!taken && outOfRange && (
        <p className="mt-1 text-xs text-charcoal-muted">
          {code.trim()} sits outside the {section.label.toLowerCase()} range. That is
          allowed — it will sort where its number puts it.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm text-charcoal">
          <input
            type="checkbox"
            checked={active}
            onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4 rounded border-sand-border"
          />
          Active
        </label>
        <div className="ml-auto flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-sand-border px-4 py-2 text-sm font-semibold text-charcoal hover:bg-sand"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={!canSave}
            className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-hover disabled:opacity-50"
          >
            Add account
          </button>
        </div>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

export function EmptyState({
  filtering,
  onClear,
}: {
  filtering: boolean;
  onClear: () => void;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-12 text-center">
      <p className="text-base font-semibold text-charcoal">
        {filtering ? 'No account matches that' : 'No accounts yet'}
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-charcoal-muted">
        {filtering
          ? 'Try part of the number, or part of the name.'
          : 'A chart of accounts arrives with the property. If this is empty, something went wrong setting it up.'}
      </p>
      {filtering && (
        <button
          type="button"
          onClick={onClear}
          className="mt-4 text-sm font-semibold text-charcoal underline underline-offset-2"
        >
          Clear the search
        </button>
      )}
    </div>
  );
}
