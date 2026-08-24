import { useCallback, useEffect, useState } from 'react';
import { CalculationNote } from '../../ui/CalculationNote';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { formatDisplayDate } from '../../../lib/date';
import { AccountPicker } from './AccountPicker';
import {
  addPropertyOverride,
  fetchMappingStatus,
  groupMappings,
  neverPostedCount,
  removePropertyOverride,
  roleKeyLabel,
  accountLabel,
  setMappingAccount,
  type GroupedMappings,
  type MappingRow,
} from '../../../lib/accounting';

// THE ACCOUNTS TAB (044) — role key to account, readable and changeable without
// a migration. Half the point of the ledger spine is this screen: a ledger
// nobody can see the wiring of is a ledger nobody trusts.
//
// WHAT IT IS NOT. Not a trial balance, not a P&L, not an account statement. This
// screen says WHERE money goes, never HOW MUCH has gone there. Every figure-
// bearing report is stage 11, and the one number on this page is a count of
// unwired keys, not an amount.
//
// THE COLUMN THAT MATTERS IS "LAST POSTED". It is DERIVED by
// account_mapping_status, never maintained by hand, and a blank means NOTHING
// HAS EVER POSTED THROUGH THIS KEY. Today most of them are blank, because the
// stock RPCs are wired in 1.1h2 and the folio in 1.1h4 — the dated gap recorded
// in 044's header. That is exactly why the column exists: the header will be
// history long before somebody wonders whether F&B is posting, and this answers
// it in a glance. It is also how a hotel finds out in month two that it created
// a charge category nothing has ever been charged to.
//
// RULE 25: one line of purpose, then the controls. What a role key IS, why a
// missing mapping refuses rather than guessing, and what an override is for all
// live behind the ⓘ and in the guide — not in paragraphs above the table.

interface MappingsTabProps {
  tenantId: string;
  propertyId: string;
  // Owners and managers only. The screen hides the controls for everyone else
  // purely so nobody is offered something they cannot use; 044's
  // is_tenant_admin() policies are the guard (rule 19).
  canEdit: boolean;
}

export function MappingsTab({
  tenantId,
  propertyId,
  canEdit,
}: MappingsTabProps) {
  const toast = useToast();
  const [groups, setGroups] = useState<GroupedMappings[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  // Bumped after a successful write to re-read. A nonce rather than calling the
  // loader directly, so there is ONE load path with one cancellation guard —
  // the ItemDetailScreen pattern, and the reason is the guard below.
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  // THE CANCELLED FLAG IS NOT CEREMONY. Switching property re-runs this effect
  // while the previous fetch is still in flight, and without the guard the older
  // response can land last and paint the previous property's mappings under the
  // new property's heading — a wrong chart of accounts, shown confidently, with
  // nothing on screen to say so.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const rows = await fetchMappingStatus(tenantId, propertyId);
        if (cancelled) return;
        setGroups(groupMappings(rows));
        setError(null);
      } catch (e) {
        // Rule 11: surfaced, never swallowed. Rule 21: the database's own words.
        if (!cancelled) {
          setError(humanizeError(e));
          setGroups(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, nonce]);

  async function repoint(row: MappingRow, accountId: string) {
    const target = row.override ?? row.fallback;
    if (!target || accountId === target.account_id) return;
    setBusyKey(row.roleKey);
    try {
      await setMappingAccount(target.mapping_id, accountId);
      reload();
      toast.success(`${roleKeyLabel(row.roleKey)} now posts to a different account.`);
    } catch (e) {
      // Rule 21: the database's message and its hint, verbatim. This screen
      // authors neither.
      toast.error(humanizeError(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function addOverride(row: MappingRow, accountId: string) {
    setBusyKey(row.roleKey);
    try {
      await addPropertyOverride(tenantId, propertyId, row.roleKey, accountId);
      reload();
      toast.success(`This property now has its own account for ${roleKeyLabel(row.roleKey)}.`);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusyKey(null);
    }
  }

  async function dropOverride(row: MappingRow) {
    if (!row.override) return;
    setBusyKey(row.roleKey);
    try {
      await removePropertyOverride(row.override.mapping_id);
      reload();
      toast.success(`${roleKeyLabel(row.roleKey)} is back to the group default here.`);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusyKey(null);
    }
  }

  const unwired = groups ? neverPostedCount(groups) : 0;

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

      {groups === null && !error && (
        <p className="text-sm text-charcoal-muted">Loading…</p>
      )}

      {groups !== null && groups.length === 0 && (
        <p className="text-sm text-charcoal-muted">
          No accounts are mapped yet. They arrive with the property.
        </p>
      )}

      {groups !== null && groups.length > 0 && (
        <>
          {/* Rule 16: the one summary figure on this page says how it was
              worked out, AND says what it does not mean. "Never posted" is not
              an alarm on its own — most modules are wired in a later shipment —
              and a screen that implied otherwise would train people to ignore
              it. */}
          <p className="mb-5 flex items-center gap-2 text-sm text-charcoal-muted">
            <span>
              {unwired === 0
                ? 'Every account here has had something posted to it.'
                : `${unwired} of these have never had anything posted to them.`}
            </span>
            <CalculationNote note="Counted from the ledger itself: an account is 'never posted' when no journal line has ever used its role key at this property. It is not necessarily a mistake — a module that has not been connected yet will show as never posted." />
          </p>

          <div className="space-y-8">
            {groups.map(({ group, rows }) => (
              <section key={group.id}>
                <h3 className="text-sm font-semibold text-charcoal">{group.title}</h3>
                <p className="mb-2 text-xs text-charcoal-muted">{group.blurb}</p>

                {/* The table scrolls sideways inside its own container at
                    360px rather than making the page scroll (rule 23's
                    sibling). Every floating layer inside it — the picker's
                    panel — is portalled, so nothing here can clip it. */}
                <div className="overflow-x-auto rounded-lg border border-sand-border">
                  <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-sand/60 text-left text-xs text-charcoal-muted">
                      <tr>
                        <th className="px-3 py-2 font-medium">Posts as</th>
                        <th className="px-3 py-2 font-medium">Account</th>
                        <th className="px-3 py-2 font-medium">Last posted</th>
                        <th className="px-3 py-2 font-medium">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <MappingTableRow
                          key={row.roleKey}
                          row={row}
                          tenantId={tenantId}
                          canEdit={canEdit}
                          busy={busyKey === row.roleKey}
                          onRepoint={(accountId) => void repoint(row, accountId)}
                          onAddOverride={(accountId) => void addOverride(row, accountId)}
                          onDropOverride={() => void dropOverride(row)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One row
// ---------------------------------------------------------------------------

interface MappingTableRowProps {
  row: MappingRow;
  tenantId: string;
  canEdit: boolean;
  busy: boolean;
  onRepoint: (accountId: string) => void;
  onAddOverride: (accountId: string) => void;
  onDropOverride: () => void;
}

export function MappingTableRow({
  row,
  tenantId,
  canEdit,
  busy,
  onRepoint,
  onAddOverride,
  onDropOverride,
}: MappingTableRowProps) {
  const [adding, setAdding] = useState(false);
  const effective = row.effective;

  // A row with no mapping at all cannot happen from the seed, but a tenant can
  // delete one — and when they do, this is the row that says so, rather than a
  // blank cell that reads like a loading state.
  if (!effective) {
    return (
      <tr className="border-t border-sand-border">
        <td className="px-3 py-2 font-medium text-charcoal">
          {roleKeyLabel(row.roleKey)}
        </td>
        <td className="px-3 py-2 text-red-700" colSpan={3}>
          Not mapped — anything that posts here will be refused.
        </td>
      </tr>
    );
  }

  return (
    <tr className="border-t border-sand-border align-top">
      <td className="px-3 py-2">
        <span className="font-medium text-charcoal">{roleKeyLabel(row.roleKey)}</span>
        <br />
        <code className="text-[11px] text-charcoal-muted">{row.roleKey}</code>
      </td>

      <td className="px-3 py-2">
        {canEdit ? (
          <AccountPicker
            label={`Account for ${roleKeyLabel(row.roleKey)}`}
            value={effective.account_id}
            selectedLabel={accountLabel({
              code: effective.account_code,
              name: effective.account_name,
            })}
            onChange={onRepoint}
            tenantId={tenantId}
            disabled={busy}
          />
        ) : (
          <span className="text-charcoal">
            {accountLabel({
              code: effective.account_code,
              name: effective.account_name,
            })}
          </span>
        )}

        {/* A LIVE CONSEQUENCE, not teaching: it appears only when this property
            differs from the group, and it names which. Rule 25 keeps this on
            screen for exactly that reason. */}
        {row.override && (
          <p className="mt-1 text-xs text-charcoal-muted">
            This property only. The group uses{' '}
            {row.fallback
              ? accountLabel({
                  code: row.fallback.account_code,
                  name: row.fallback.account_name,
                })
              : 'nothing'}
            .
          </p>
        )}
        {!effective.account_is_active && (
          <p className="mt-1 text-xs text-red-700">
            That account is switched off, so postings here will be refused.
          </p>
        )}
      </td>

      <td className="px-3 py-2 whitespace-nowrap">
        {effective.last_posted_on ? (
          <span className="text-charcoal">
            {formatDisplayDate(effective.last_posted_on)}
          </span>
        ) : (
          <span className="text-charcoal-muted">Never</span>
        )}
      </td>

      <td className="px-3 py-2 text-right">
        {canEdit && row.override && (
          <button
            type="button"
            onClick={onDropOverride}
            disabled={busy}
            className="text-xs font-semibold text-charcoal underline underline-offset-2 disabled:opacity-50"
          >
            Use the group account
          </button>
        )}
        {canEdit && !row.override && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            disabled={busy}
            className="text-xs font-semibold text-charcoal underline underline-offset-2 disabled:opacity-50"
          >
            Use a different account here
          </button>
        )}
        {canEdit && !row.override && adding && (
          <div className="min-w-[220px] text-left">
            <AccountPicker
              label={`Account for ${roleKeyLabel(row.roleKey)} at this property`}
              value=""
              selectedLabel={null}
              onChange={(accountId) => {
                setAdding(false);
                onAddOverride(accountId);
              }}
              tenantId={tenantId}
              disabled={busy}
            />
            <button
              type="button"
              onClick={() => setAdding(false)}
              className="mt-1 text-xs text-charcoal-muted underline underline-offset-2"
            >
              Cancel
            </button>
          </div>
        )}
      </td>
    </tr>
  );
}
