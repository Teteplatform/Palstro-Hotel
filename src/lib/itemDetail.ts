import { supabase } from './supabase';
import { fetchAllPagedRows } from './fetchAllPaged';
import { boundary } from './rowParse';
import { ledgerRows, onHandRows } from './stock';
import type { MovementType, StockLedgerRow, StockOnHandRow } from '../types/stock';

// THE DATA BEHIND ONE ITEM'S PAGE (1.1f) — its movements at a scope, the figures
// that summarise them, and the series the chart draws.
//
// ---------------------------------------------------------------------------
// WHAT IT ADDS TO lib/stock, AND WHY IT IS A SEPARATE FILE
// ---------------------------------------------------------------------------
// lib/stock answers "what is on this shelf" for a LIST. This file answers "what
// happened to this item" for ONE item, at one location or across the property —
// which is a different question with a different scope rule, and folding it into
// fetchItemLedger would have meant a locationId parameter that is sometimes null
// and a running figure that means two different things depending on it. Two
// functions that each mean one thing.
//
// ---------------------------------------------------------------------------
// THE ONE PLACE THIS COMPUTES SOMETHING THE DATABASE COULD HAVE
// ---------------------------------------------------------------------------
// stock_movement_ledger's running_quantity is PER LOCATION: the view's lateral
// join filters `m2.location_id = m.location_id`, because a weighted average is a
// property of one physical pile and 036 §1 is explicit that there is no
// property-wide "stock of rice" except as a deliberate roll-up.
//
// So at ALL-LOCATIONS scope there is no running property total to read, and the
// series is accumulated here instead (§ runningPropertyQuantity). That is a
// deliberate exception to "nothing here computes a quantity", and the distinction
// it rests on is worth stating exactly, because the superficially similar thing
// is the trap 022 and 036 both record:
//
//   WHAT WOULD BE WRONG: re-deriving a weighted-average COST in TypeScript. The
//   average is path-dependent, so a second implementation drifts from the first
//   the day either changes, and then the working shown disagrees with the number
//   shown while nothing errors.
//
//   WHAT THIS IS: a running SUM of the `quantity` column. 036 states the
//   invariant `quantity_on_hand === sum(stock_movements.quantity)` and says it
//   holds BY CONSTRUCTION — the fold's quantity IS that sum. Adding the column up
//   is therefore not a second opinion about anything; it is the addition the
//   invariant already promises, and its endpoint is checkable against the view.
//
// The proof does check it: the last point of the series must equal
// stock_on_hand_by_item.quantity_on_hand at property scope, and
// stock_on_hand_items.quantity_on_hand at one location. That assertion is what
// makes this a shortcut rather than a belief.
//
// ---------------------------------------------------------------------------
// ORDERING ACROSS LOCATIONS DEPENDS ON `seq` BEING TABLE-WIDE — IT IS
// ---------------------------------------------------------------------------
// At property scope this interleaves movements from different locations into one
// series ordered by (business_date, seq). That order is only meaningful if `seq`
// is a single sequence across the whole table: were it ever per-location or
// per-partition, the chart would draw a timeline that never happened, and it
// would look entirely plausible while doing it.
//
// VERIFIED, not assumed: 036 declares `seq bigint generated always as identity`
// on stock_movements — one table-wide identity sequence, described in its own
// column comment as "monotonic in real insertion order, within and across
// transactions". There is no partitioning and no per-location sequence anywhere
// in the schema. The dry run asserts it empirically as well, by interleaving
// movements in two locations and checking the seq order matches the insertion
// order, so a future change to how seq is generated fails loudly here.
//
// ---------------------------------------------------------------------------
// SCALE NOTE — FOR THE PERFORMANCE PASS, DELIBERATELY NOT SOLVED HERE
// ---------------------------------------------------------------------------
// This reads EVERY movement for the item at the scope, complete (rule 1a), the
// same as fetchItemLedger. That is right today — a hotel a few months in has a
// handful of movements per item, and a valuation trail missing its middle proves
// nothing — and it is wrong at a year of trading, where an item that moves daily
// in four locations will pull a few thousand rows to draw one chart.
//
// NOT FIXED IN 1.1f, on purpose. The fix is either a server-side aggregate for
// the cards (which the cards could use without the ledger) or downsampling the
// series, and which one is right depends on what the distribution actually looks
// like — a decision to make with real data in front of you rather than a guess
// now. Recorded here so it goes against the performance pass with its reasoning
// attached, instead of being rediscovered as a slow screen.

// ---------------------------------------------------------------------------
// Scope
// ---------------------------------------------------------------------------

// NULL means "every location in this property" — the roll-up, never a missing
// filter. The same convention the products list uses, so the two screens cannot
// mean different things by the same value.
export type ItemScope = string | null;

// ---------------------------------------------------------------------------
// The movements
// ---------------------------------------------------------------------------

// One movement as this page needs it: the ledger row, plus the running quantity
// AT THE PAGE'S SCOPE. At one location that is the database's own figure; across
// the property it is the accumulated sum described in the header.
export interface ItemMovement extends StockLedgerRow {
  // The stock level after this movement, at the page's scope. Named apart from
  // running_quantity so a reader can never be in doubt about which one they have:
  // the ledger's is the location's, this one is the scope's, and at one location
  // they are equal by construction.
  scoped_quantity: number;
}

// Every movement of one item at a scope, oldest first.
//
// The location filter is applied SERVER-SIDE when there is one; at property scope
// no location predicate is sent, so the read is one query either way rather than
// one per location.
export async function fetchItemMovements(
  tenantId: string,
  propertyId: string,
  inventoryItemId: string,
  scope: ItemScope,
): Promise<ItemMovement[]> {
  const rows = await fetchAllPagedRows<StockLedgerRow>(ledgerRows, (from, to) => {
    let q = supabase
      .from('stock_movement_ledger')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19 — stock is physical
      .eq('inventory_item_id', inventoryItemId);
    if (scope) q = q.eq('location_id', scope);
    return q
      .order('business_date', { ascending: true }) // rule 8: the business timeline
      .order('seq', { ascending: true }) // the fold's own tiebreak, table-wide
      .range(from, to);
  });

  return scope ? atLocation(rows) : acrossProperty(rows);
}

// ONE LOCATION: the running figure is the DATABASE's, unchanged. There is nothing
// to compute, and computing it anyway would be the second implementation the
// header warns about.
function atLocation(rows: StockLedgerRow[]): ItemMovement[] {
  return rows.map((row) => ({ ...row, scoped_quantity: row.running_quantity }));
}

// ACROSS THE PROPERTY: the running total accumulated over the interleaved
// movements. See the header for why this is the invariant's own addition rather
// than a re-derivation — and note it sums `quantity`, the signed column, never
// running_quantity, which is each location's own balance and would be nonsense
// added together.
function acrossProperty(rows: StockLedgerRow[]): ItemMovement[] {
  let total = 0;
  return rows.map((row) => {
    total += row.quantity;
    return { ...row, scoped_quantity: total };
  });
}

// ---------------------------------------------------------------------------
// The position at the scope
// ---------------------------------------------------------------------------

// The roll-up view's shape, for property scope. A projection of its own, so the
// boundary names exactly the columns this read asks for.
interface ItemRollupRow {
  inventory_item_id: string;
  quantity_on_hand: number;
  stock_value: number;
  // NULL when nothing is on hand: with no quantity there is no meaningful unit
  // cost, and the view returns NULL rather than dividing by zero (036 §3.3).
  moving_average_cost: number | null;
  location_count: number;
  retail_value: number | null;
  default_selling_price: number | null;
}

const rollupRow = boundary<ItemRollupRow>('stock_on_hand_by_item (item page)')(
  ['quantity_on_hand', 'stock_value', 'location_count'] as const,
  ['moving_average_cost', 'retail_value', 'default_selling_price'] as const,
);

// What the page's On hand and Value cards read. One shape for both scopes, so the
// screen has no branch in it.
export interface ItemPosition {
  quantity: number;
  value: number;
  averageCost: number | null;
  // How many locations hold this item, at property scope. NULL at one location,
  // where the question does not arise.
  locationCount: number | null;
}

// NULL — not a zero position — when the item has never moved at this scope. The
// distinction is the one ProductRow already makes: "we hold none" and "we have no
// figure" are different statements, and the screen renders them differently.
export async function fetchItemPositionAtScope(
  tenantId: string,
  propertyId: string,
  inventoryItemId: string,
  scope: ItemScope,
): Promise<ItemPosition | null> {
  if (scope) {
    const { data, error } = await supabase
      .from('stock_on_hand_items')
      .select('*')
      .eq('tenant_id', tenantId) // rule 19
      .eq('property_id', propertyId) // rule 19
      .eq('location_id', scope)
      .eq('inventory_item_id', inventoryItemId)
      .maybeSingle();
    if (error) throw error;
    const row: StockOnHandRow | null = onHandRows.maybeRow(data);
    return row
      ? {
          quantity: row.quantity_on_hand,
          value: row.stock_value,
          averageCost: row.moving_average_cost,
          locationCount: null,
        }
      : null;
  }

  const { data, error } = await supabase
    .from('stock_on_hand_by_item')
    // prettier-ignore
    .select('inventory_item_id,quantity_on_hand,stock_value,moving_average_cost,location_count,retail_value,default_selling_price')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('inventory_item_id', inventoryItemId)
    .maybeSingle();
  if (error) throw error;
  const row = rollupRow.maybeRow(data);
  return row
    ? {
        quantity: row.quantity_on_hand,
        value: row.stock_value,
        averageCost: row.moving_average_cost,
        locationCount: row.location_count,
      }
    : null;
}

// ---------------------------------------------------------------------------
// The cards (§2)
// ---------------------------------------------------------------------------

// THE MOVEMENT TYPES THAT HAVE A WRITE PATH TODAY, and nothing else.
//
// opening and adjustment are 036's; count_adjustment is written by a posted stock
// take (039); reversal is produced by reverse_stock_movement (038) and is never
// chosen on a form. Receipts, issues, transfers, consumption and wastage are all
// declared in the enum and none of them can be written yet.
//
// A CARD READING "Purchases 0" WOULD TEACH THE WRONG THING — it says the hotel
// bought nothing, when the truth is that receiving does not exist. The cards
// arrive with their write paths in 1.1g and the requisition work, and not before.
export const CARD_MOVEMENT_TYPES: readonly MovementType[] = [
  'opening',
  'adjustment',
  'count_adjustment',
  'reversal',
];

export interface MovementTypeTotal {
  type: MovementType;
  // The NET quantity this type accounts for, in the base unit. Signed: reversals
  // and downward adjustments are negative, and showing them as magnitudes would
  // break the one thing these cards are for (§ cardsReconcile).
  quantity: number;
  // The net value moved, from the view's own movement_value — the signed figure
  // the fold produced, never quantity × a cost recomputed here.
  value: number;
  // How many movements are behind the figure, so a card with one big correction
  // reads differently from one with forty small ones.
  count: number;
}

// The card figures, from the movements already loaded. Every type in
// CARD_MOVEMENT_TYPES gets an entry even at zero, because a card that appears and
// disappears makes the row jump and makes "Adjustments 0" — a real and reassuring
// fact — unsayable.
export function summariseByType(movements: ItemMovement[]): MovementTypeTotal[] {
  const totals = new Map<MovementType, MovementTypeTotal>(
    CARD_MOVEMENT_TYPES.map((type) => [type, { type, quantity: 0, value: 0, count: 0 }]),
  );

  for (const m of movements) {
    const entry = totals.get(m.movement_type);
    // A movement of a type with no card is deliberately NOT dropped silently —
    // see unaccountedQuantity, which is what would make the reconciliation lie.
    if (!entry) continue;
    entry.quantity += m.quantity;
    entry.value += m.movement_value;
    entry.count += 1;
  }

  return CARD_MOVEMENT_TYPES.map((type) => totals.get(type)!);
}

// THE GUARD ON §2's PROMISE. The cards must sum to what On hand says, and they do
// only while every movement belongs to a card. The moment a write path for
// receipts opens without a card being added, this becomes non-zero and the screen
// says so out loud rather than showing a row of cards that quietly does not add
// up.
//
// It is the same principle as the summary card's excluded count: a total that
// silently ignores part of its set is worse than no total.
export function unaccountedQuantity(movements: ItemMovement[]): number {
  return movements
    .filter((m) => !CARD_MOVEMENT_TYPES.includes(m.movement_type))
    .reduce((sum, m) => sum + m.quantity, 0);
}

// The sum the cards claim. Extracted so the screen and the proof assert the same
// arithmetic rather than two copies of it.
export function cardsTotal(totals: MovementTypeTotal[]): number {
  return totals.reduce((sum, t) => sum + t.quantity, 0);
}

// numeric(14,4) is four decimal places, so two figures that are equal can differ
// in the last bits after a float round-trip. A tolerance of half a ten-thousandth
// is tighter than the column's own precision and looser than IEEE noise.
const QUANTITY_EPSILON = 0.00005;

// Whether the cards reconcile to the on-hand figure — §2's whole point, and the
// reason this page is worth building. Exported so the screen can SAY it rather
// than merely be it.
export function cardsReconcile(
  totals: MovementTypeTotal[],
  position: ItemPosition | null,
): boolean {
  const onHand = position?.quantity ?? 0;
  return Math.abs(cardsTotal(totals) - onHand) < QUANTITY_EPSILON;
}
