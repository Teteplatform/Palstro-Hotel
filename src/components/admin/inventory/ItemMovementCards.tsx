import { CalculationNote } from '../../ui/CalculationNote';
import { formatMoney, formatQuantity, formatSignedQuantity, MISSING_VALUE } from '../../../lib/format';
import { movementTypeLabel } from '../../../lib/stockLabels';
import {
  cardsReconcile,
  cardsTotal,
  type ItemPosition,
  type MovementTypeTotal,
} from '../../../lib/itemDetail';
import type { MovementType } from '../../../types/stock';

// THE CARDS ACROSS THE TOP OF THE ITEM PAGE (1.1f §2) — where this item's stock
// came from, and what it adds up to.
//
// ---------------------------------------------------------------------------
// THE CARDS SUM TO ON HAND. THAT IS THE WHOLE POINT OF THE PAGE.
// ---------------------------------------------------------------------------
// Every quantity in this system is the sum of its movements (036: there is no
// stored balance anywhere). This row is that sentence made visible: four movement
// types, each netting to a figure, and their total IS the on-hand quantity beside
// them. A storekeeper who does not believe the number can add up the cards, and a
// manager asking "where did 40 kg go" gets the answer in one line.
//
// So the row SAYS whether it reconciles rather than merely doing so. If a movement
// type ever gets a write path without getting a card — which is exactly what will
// happen when receiving lands in 1.1g — the total stops matching, and this says so
// out loud instead of showing a tidy row of cards that quietly does not add up.
// Same principle as the summary card's excluded count: a total that silently
// ignores part of its set is worse than no total.
//
// ---------------------------------------------------------------------------
// ONLY THE TYPES THAT CAN BE WRITTEN TODAY
// ---------------------------------------------------------------------------
// Opening balance, Adjustments, Count corrections, Reversals. Purchases and issues
// are declared in the movement enum and have no write path, so a "Purchases 0"
// card would not be an empty state — it would be a claim that this hotel has
// bought nothing, when the truth is that receiving does not exist yet. The cards
// arrive with their write paths (CARD_MOVEMENT_TYPES in lib/itemDetail).
//
// ---------------------------------------------------------------------------
// A CARD IS A FILTER, AND IT LOOKS LIKE ONE
// ---------------------------------------------------------------------------
// Pressing a card narrows the ledger below to that type; pressing it again, or
// the "Show everything" control, goes back. One at a time — a multi-select here
// would make "the cards sum to on hand" ambiguous the moment two were lit.
// aria-pressed carries the state, so it is not only a colour.

interface ItemMovementCardsProps {
  totals: MovementTypeTotal[];
  position: ItemPosition | null;
  baseUnit: string;
  currency: string;
  // Movements whose type has no card. Non-zero means the row no longer reconciles,
  // and the row says so — see the header.
  unaccounted: number;
  // NULL = showing everything.
  selected: MovementType | null;
  onSelect: (type: MovementType | null) => void;
  loading: boolean;
}

export function ItemMovementCards({
  totals,
  position,
  baseUnit,
  currency,
  unaccounted,
  selected,
  onSelect,
  loading,
}: ItemMovementCardsProps) {
  const reconciles = cardsReconcile(totals, position) && unaccounted === 0;
  const total = cardsTotal(totals);

  return (
    <section aria-label="Where this stock came from">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {totals.map((entry) => (
          <MovementCard
            key={entry.type}
            entry={entry}
            baseUnit={baseUnit}
            currency={currency}
            selected={selected === entry.type}
            onClick={() =>
              onSelect(selected === entry.type ? null : entry.type)
            }
            disabled={loading}
          />
        ))}

        {/* THE TWO FIGURES THE CARDS ADD UP TO. Not buttons: they are the answer,
            not another filter, and making them pressable would suggest a fifth and
            sixth movement type. */}
        <ResultTile
          label="On hand"
          value={
            position === null
              ? MISSING_VALUE
              : `${formatQuantity(position.quantity)}`
          }
          sub={position === null ? 'never moved here' : baseUnit}
          note="The sum of every movement of this item at this scope — which is what the four cards beside it add up to. Nothing is stored: it is recomputed from the movements each time this page loads."
          tone={position !== null && position.quantity < 0 ? 'alert' : 'strong'}
        />
        <ResultTile
          label="Value"
          value={position === null ? MISSING_VALUE : formatMoney(position.value, currency)}
          sub={
            position?.averageCost != null
              ? `${formatMoney(position.averageCost, currency)} per ${baseUnit}`
              : 'no unit cost'
          }
          note="Quantity on hand × the moving average cost, at cost and not at what it would sell for. Both figures are folded from the movements on every read, so neither can drift from the other."
          tone="strong"
        />
      </div>

      {/* THE RECONCILIATION, SAID OUT LOUD. Only ever shown when it FAILS: a
          permanent green "these add up" would be read once and then never again,
          which is exactly when it would start mattering. */}
      {!loading && !reconciles ? (
        <p
          role="alert"
          className="mt-3 rounded-xl border border-accent/40 bg-accent/10 px-3 py-2 text-xs text-charcoal"
        >
          <span className="font-semibold">These cards do not add up to On hand.</span>{' '}
          They come to {formatQuantity(total)} {baseUnit} against{' '}
          {position === null ? 'no position' : `${formatQuantity(position.quantity)} ${baseUnit}`}
          {unaccounted !== 0 ? (
            <>
              , because {formatSignedQuantity(unaccounted)} {baseUnit} moved through a
              type that has no card yet
            </>
          ) : null}
          . The ledger below is complete — trust it over this row.
        </p>
      ) : null}
    </section>
  );
}

function MovementCard({
  entry,
  baseUnit,
  currency,
  selected,
  onClick,
  disabled,
}: {
  entry: MovementTypeTotal;
  baseUnit: string;
  currency: string;
  selected: boolean;
  onClick: () => void;
  disabled: boolean;
}) {
  // A card with nothing behind it cannot filter to anything, so it does not offer
  // to. It still SHOWS — "Adjustments 0" is a real and reassuring fact about an
  // item nobody has corrected — but pressing it would produce an empty table and
  // a puzzle about why.
  const empty = entry.count === 0;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || empty}
      aria-pressed={selected}
      className={`rounded-xl px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-default ${
        selected
          ? 'bg-primary text-white ring-2 ring-primary ring-offset-1 ring-offset-cream'
          : empty
            ? 'bg-sand/30'
            : 'bg-sand/40 hover:bg-sand'
      }`}
    >
      <span
        className={`block text-[11px] font-semibold tracking-wide uppercase ${
          selected ? 'text-white/80' : 'text-charcoal-muted'
        }`}
      >
        {movementTypeLabel(entry.type)}
      </span>
      <span
        className={`mt-1 block text-lg font-bold tabular-nums ${
          selected ? 'text-white' : 'text-charcoal'
        }`}
      >
        {/* SIGNED, always. These are net contributions to a total, and a reversal
            shown as a magnitude would break the addition the row exists to make. */}
        {entry.count === 0 ? formatQuantity(0) : formatSignedQuantity(entry.quantity)}
      </span>
      <span
        className={`block text-[11px] ${selected ? 'text-white/80' : 'text-charcoal-muted'}`}
      >
        {baseUnit}
        {/* VALUE ONLY WHERE IT MEANS SOMETHING. A count correction of −3 kg has a
            real value (the stock it wrote off) and a card with no movements has
            none — showing ₦0.00 there would be a figure rather than a blank. */}
        {entry.count > 0 ? ` · ${formatMoney(entry.value, currency)}` : ''}
      </span>
      <span
        className={`mt-0.5 block text-[11px] ${
          selected ? 'text-white/70' : 'text-charcoal-muted'
        }`}
      >
        {entry.count === 0
          ? 'none yet'
          : `${entry.count} movement${entry.count === 1 ? '' : 's'}${selected ? ' · showing' : ''}`}
      </span>
    </button>
  );
}

function ResultTile({
  label,
  value,
  sub,
  note,
  tone,
}: {
  label: string;
  value: string;
  sub: string;
  note: string;
  tone: 'strong' | 'alert';
}) {
  return (
    <div
      className={`rounded-xl px-3 py-2.5 ${
        tone === 'alert' ? 'bg-accent/15' : 'bg-primary/10'
      }`}
    >
      <div className="flex items-start gap-1.5">
        <span className="text-[11px] font-semibold tracking-wide text-charcoal-muted uppercase">
          {label}
        </span>
        <CalculationNote note={note} />
      </div>
      <p
        className={`mt-1 text-lg font-bold tabular-nums ${
          tone === 'alert' ? 'text-accent' : 'text-primary'
        }`}
      >
        {value}
      </p>
      <p className="text-[11px] text-charcoal-muted">{sub}</p>
    </div>
  );
}
