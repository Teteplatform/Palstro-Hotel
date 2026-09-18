import { useEffect, useState } from 'react';
import { CalculationNote } from '../../ui/CalculationNote';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity } from '../../../lib/format';
import {
  fetchInventoryReconciliation,
  fetchInventoryReconciliationPositions,
} from '../../../lib/purchasing';
import type {
  InventoryGlReconciliation,
  InventoryReconciliationPosition,
} from '../../../types/purchasing';

// DOES THE LEDGER AGREE WITH THE STOCK? (046 §7.6)
//
// ---------------------------------------------------------------------------
// WHY THIS IS ON A SCREEN AND NOT ONLY IN A DRY RUN
// ---------------------------------------------------------------------------
// The dry run asserts this on the day the migration is written. A check nobody
// can run afterwards is a check that was true once — and the failure it exists
// to catch is not a failure at write time, it is a posting site added six months
// later that forgets to book. That is exactly what happened on the ERP: its
// general ledger read 782,500 in Stock on Hand against a subledger of 732,500,
// and nobody could say which of the two was wrong or when they parted.
//
// ---------------------------------------------------------------------------
// TWO FIGURES, AND CONFLATING THEM WOULD MAKE BOTH USELESS
// ---------------------------------------------------------------------------
//   THE LEDGER CHECK must be ZERO, always, to the kobo. One side is read from
//   the journal lines that were actually written; the other is computed
//   independently from the stock movements. Any difference at all means a
//   posting was skipped, doubled, or landed on the wrong account. This is the
//   one that is allowed to be alarming.
//
//   THE VALUATION CHECK is NOT required to be zero, and a screen that treated it
//   as an error would train everybody to ignore both. Money carries two
//   decimals and a moving average does not, so a few kobo of rounding is normal
//   and correct.
//
//   TWO THINGS MAKE THAT RESIDUE READABLE RATHER THAN BACKGROUND NOISE, and
//   without them it is a number nobody can act on:
//
//     THE DENOMINATOR. A kobo across forty movements is arithmetic. THE SAME
//     KOBO ACROSS FOUR THOUSAND IS SOMETHING ELSE, and the only way anybody ever
//     notices the difference is if both figures are on the screen together.
//     Rounding scales with the count; an error does not.
//
//     THE NAMED EXCEPTION. A difference beyond rounding almost always has one
//     cause: a position that passed through negative, after which the fold reset
//     its average to the incoming cost (038 §5.1). So the card NAMES THE ITEMS —
//     "Rice, Main Store: this position has been below zero, so its average was
//     reset" — because an unexplained variance is one an owner will either ignore
//     or panic about, and a named one is a sentence they can act on.
//
//   THAT IS ALSO WHERE 046 WAS WRONG, not merely thin: it counted positions
//   below zero TODAY. The positions that cause a divergence are usually POSITIVE
//   again by the time anybody looks, because the reset happens when stock
//   arrives. 047 asks the right question — has the running quantity EVER been
//   below zero — and this card reads that.
//
// Neither is absorbed anywhere. There is no suspense account and no tolerance
// setting, which is what makes the first figure worth reading at all.

interface InventoryReconciliationPanelProps {
  propertyId: string;
  currency: string;
}

export function InventoryReconciliationPanel({
  propertyId,
  currency,
}: InventoryReconciliationPanelProps) {
  const [row, setRow] = useState<InventoryGlReconciliation | null>(null);
  const [positions, setPositions] = useState<InventoryReconciliationPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const [result, pos] = await Promise.all([
          fetchInventoryReconciliation(propertyId),
          fetchInventoryReconciliationPositions(propertyId),
        ]);
        if (cancelled) return;
        setRow(result);
        setPositions(pos);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // The server's own words, including a missing `inventory` mapping —
        // which is a real answer to "why can this not be checked" (rules 11, 21).
        setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [propertyId]);

  if (loading) {
    return (
      <p className="py-4 text-center text-sm text-charcoal-muted">
        Checking the stock against the ledger…
      </p>
    );
  }

  if (error) {
    return (
      <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal">
        {error}
      </p>
    );
  }

  if (!row) return null;

  return (
    <InventoryReconciliationCard row={row} positions={positions} currency={currency} />
  );
}

// EXPORTED so a render proof can drive the REAL card rather than a copy of it
// (rule 22), with a fixture that is a kobo out and one that is not.
export function InventoryReconciliationCard({
  row,
  positions,
  currency,
}: {
  row: InventoryGlReconciliation;
  positions: InventoryReconciliationPosition[];
  currency: string;
}) {
  const balanced = row.ledger_difference === 0;
  const drift = row.valuation_difference;
  // THE SHELVES THE RESIDUE CAME FROM, biggest first. The function returns every
  // position including the ones that reconcile exactly — which is what makes the
  // set honest — and the card shows the ones that do not.
  const differing = positions.filter((p) => p.difference !== 0);

  return (
    <div className="space-y-3 rounded-2xl border border-sand-border bg-white/60 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-base font-semibold text-charcoal">
          Stock against the ledger
        </h3>
        <span
          className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
            balanced
              ? 'bg-emerald-100 text-emerald-900'
              : 'bg-primary/15 text-primary'
          }`}
        >
          {balanced ? 'Agrees' : 'Does NOT agree'}
        </span>
      </div>

      <p className="text-sm text-charcoal-muted">
        {row.account_code} {row.account_name}
      </p>

      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <Figure
          label="On the ledger"
          value={formatMoney(row.ledger_balance, currency)}
          note="The balance of the inventory account for this property, added up from the journal entries that were actually written."
        />
        <Figure
          label="From the stock movements"
          value={formatMoney(row.expected_ledger_balance, currency)}
          note="What those entries should add up to, computed independently from the stock movements themselves. These two must match exactly."
        />
        <Figure
          label="Stock valuation"
          value={formatMoney(row.valuation_value, currency)}
          note="What the stock screens say this property holds, at weighted average cost. A few kobo of difference from the ledger is rounding and is normal."
        />
        <Figure
          label="Difference from the valuation"
          value={formatMoney(drift, currency)}
          // THE DENOMINATOR, ON THE FACE OF THE FIGURE rather than in its note.
          // A residue without the count it accumulated over cannot be judged at
          // all: the same kobo is arithmetic across forty movements and a
          // symptom across four thousand.
          // THROUGH THE APP'S OWN FORMATTER, so four thousand reads as 4,000
          // like every other number on this card. An unseparated 4000 beside a
          // separated 278,500.00 is the kind of small inconsistency that makes a
          // reader stop trusting the panel.
          sub={`across ${formatQuantity(row.valued_movement_count)} movement${
            row.valued_movement_count === 1 ? '' : 's'
          }`}
          note="Rounding — money has two decimals and a moving average does not — plus any position that has passed through negative, where the average resets to the incoming cost. Not required to be zero. Read it against the number of movements beneath it: rounding grows with the count, an error does not."
        />
      </dl>

      {/* THE ALARM, and it says what to do rather than only that something is
          wrong. Shown only when it applies: a permanent banner reading "0.00 out"
          is a banner nobody reads on the day it finally says something else. */}
      {!balanced ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal">
          The ledger is{' '}
          <strong className="tabular-nums">
            {formatMoney(Math.abs(row.ledger_difference), currency)}
          </strong>{' '}
          {row.ledger_difference > 0 ? 'higher' : 'lower'} than the stock
          movements say it should be. That means a movement posted twice, or one
          moved stock without posting at all. Nothing corrects this by itself —
          it needs looking at.
        </p>
      ) : null}

      {/* THE NAMED EXCEPTION. A difference beyond a few kobo has one usual
          cause, and naming the shelf turns a number into a sentence somebody
          can act on. Shown ONLY where there is a difference to explain — a list
          that prints on every property is a list nobody reads.

          EACH SENTENCE IS ONE TEMPLATE STRING rather than interleaved children:
          React separates adjacent text nodes, so "2 positions" reaches the DOM
          in three pieces and anybody selecting or reading it aloud gets it
          broken up. */}
      {differing.length > 0 ? (
        <div className="space-y-1">
          <p className="text-sm font-medium text-charcoal">
            {`Where the difference is, ${
              differing.length === 1 ? 'on 1 shelf' : `across ${differing.length} shelves`
            }:`}
          </p>
          <ul className="space-y-1 text-sm text-charcoal-muted">
            {differing.slice(0, 5).map((pos) => (
              <li key={`${pos.location_id}:${pos.inventory_item_id}`}>
                {`${pos.item_name}, ${pos.location_name} — ${formatMoney(
                  pos.difference,
                  currency,
                )} across ${formatQuantity(pos.movement_count)} movement${
                  pos.movement_count === 1 ? '' : 's'
                }. ${
                  pos.passed_through_negative
                    ? 'This position has been below zero, so when stock next arrived its average was reset to the incoming cost — that is where the difference came from.'
                    : 'Rounding: money carries two decimals and the average behind it does not.'
                }`}
              </li>
            ))}
          </ul>
          {differing.length > 5 ? (
            <p className="text-sm text-charcoal-muted">
              {`${differing.length - 5} more, smaller than these.`}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* BELOW ZERO RIGHT NOW is a different question from "has ever been", and
          it is the one somebody acts on TODAY: stock left without a movement
          behind it. Kept separate rather than merged with the sentence above. */}
      {row.negative_position_count > 0 ? (
        <p className="text-sm text-charcoal-muted">
          {`${row.negative_position_count} position${
            row.negative_position_count === 1 ? '' : 's'
          } on this property ${
            row.negative_position_count === 1 ? 'holds' : 'hold'
          } less than nothing right now, which means stock left without a movement behind it.`}
        </p>
      ) : null}

      {/* 047: value the ledger is not expected to hold, because the code that
          posts did not exist when these movements were written. Reported rather
          than absorbed — the whole reason the figure above can be trusted. */}
      {row.pre_wiring_value !== 0 ? (
        <p className="text-sm text-charcoal-muted">
          {`${formatMoney(
            row.pre_wiring_value,
            currency,
          )} of stock movement was recorded before this property began posting to the ledger, so it is in the valuation and deliberately not on the books.`}
        </p>
      ) : null}
      {row.unvaluable_movement_count > 0 ? (
        <p className="text-sm text-charcoal-muted">
          {`${row.unvaluable_movement_count} movement${
            row.unvaluable_movement_count === 1 ? '' : 's'
          } could not be valued — stock left a position that had no cost history — so ${
            row.unvaluable_movement_count === 1 ? 'it is' : 'they are'
          } on neither side.`}
        </p>
      ) : null}
    </div>
  );
}

function Figure({
  label,
  value,
  sub,
  note,
}: {
  label: string;
  value: string;
  // A UNIT ON THE FIGURE, not an explanation of it — which is why it sits under
  // the number and not behind the ⓘ. "across 8 movements" is what makes a
  // residue judgeable at all; hidden, the figure means nothing on its own.
  sub?: string;
  note: string;
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs font-medium text-charcoal-muted">
        {label}
        {/* Rule 16: every summary figure says how it was calculated. */}
        <CalculationNote note={note} />
      </dt>
      <dd className="mt-0.5 text-base font-semibold tabular-nums text-charcoal">
        {value}
      </dd>
      {sub ? <dd className="text-xs text-charcoal-muted">{sub}</dd> : null}
    </div>
  );
}
