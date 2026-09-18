import type { PurchaseOrderStatus } from '../types/purchasing';

// THE WORDS THE PURCHASING SCREENS USE (CLAUDE.md rule 25).
//
// They live here rather than inline for the reason stockLabels gives: a screen
// is for doing, so its file should be controls, and an explanation written into
// a component is an explanation nobody can find later to change. Everything in
// this file is either a LABEL (one or two words on a control) or an ⓘ PANEL
// (behind one icon, summarising what the staff guide says at length).
//
// NOTHING HERE RESTATES A DATABASE RULE AS A REFUSAL. When the server says no,
// the screen shows the server's message and its hint, verbatim (rule 21). These
// paragraphs explain what the screen is FOR, before anybody presses anything.

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// FIVE STATES, IN THE WORDS OF SOMEBODY RUNNING A STORE rather than in the
// database's. 'part_received' is the one that matters — it is the state an order
// sits in while somebody is waiting for the rest of it, and "Partly delivered"
// says that in a way "part_received" does not.
export function purchaseStatusLabel(status: PurchaseOrderStatus): string {
  switch (status) {
    case 'draft':
      return 'Draft';
    case 'ordered':
      return 'Sent';
    case 'part_received':
      return 'Partly delivered';
    case 'received':
      return 'Complete';
    case 'cancelled':
      return 'Cancelled';
    default:
      return status;
  }
}

// The colour a status badge carries. Amber is "somebody is waiting", which is
// the only state that wants attention on a list.
export function purchaseStatusTone(status: PurchaseOrderStatus): string {
  switch (status) {
    case 'draft':
      return 'bg-sand text-charcoal-muted';
    case 'ordered':
    case 'part_received':
      return 'bg-amber-100 text-amber-900';
    case 'received':
      return 'bg-emerald-100 text-emerald-900';
    case 'cancelled':
      return 'bg-sand text-charcoal-muted';
    default:
      return 'bg-sand text-charcoal-muted';
  }
}

// ---------------------------------------------------------------------------
// The ⓘ panels
// ---------------------------------------------------------------------------

export const PURCHASES_ABOUT_TITLE = 'About purchase orders';

export const PURCHASES_ABOUT = [
  'A purchase order records what you asked a supplier for, from whom, and where it is going. While it is a draft you can change anything on it. Once you send it, what was ordered is fixed — the paper in the supplier’s hand and the record here are meant to be the same document.',
  'When the goods arrive you record the delivery against the order, on the order’s own page. You enter what actually came and what the invoice says it cost, and the screen shows you the difference from what you ordered while the delivery is still at the door.',
  'Stock reaches the store through exactly the same path a hand-keyed delivery uses, so the same rules apply: only a store receives, and a delivery going anywhere else needs a manager’s PIN and a reason.',
  'Every delivery posts to the accounts: what arrived is added to Inventory, and what you owe is added to the supplier account. Nothing posts when you raise or send an order — an order is a promise, not a transaction.',
];

export const RECEIVE_ABOUT_TITLE = 'About recording a delivery';

export const RECEIVE_ABOUT = [
  'Enter what physically arrived, line by line, and what the invoice charges for one unit. Leave out any line that has not come at all — you can record it on a later delivery.',
  'Any difference between what was outstanding and what arrived needs a short reason. “Part delivery, rest Friday” is enough. It is what the short-delivery report reads, and it is the only record of why an order did not come in full.',
  'If more arrived than was ordered, a manager has to authorise accepting it, because taking it commits the hotel to paying for it.',
  'If nothing more is ever coming for a line, tick “nothing more coming”. That closes the line short so the order stops sitting in the outstanding list, and it keeps the shortfall on the record instead of quietly forgetting it.',
  'A cost different from the one you ordered at is shown, recorded, and posted at the invoiced price — it is the price you actually paid that moves the item’s average cost. No reason is required for a price change; seeing it while the driver is still there is what catches one.',
];

export const SUPPLIERS_ABOUT_TITLE = 'About suppliers';

export const SUPPLIERS_ABOUT = [
  'The suppliers list is the address book: who the hotel buys from, who to call, and how they get paid. It is shared across every property in the group, so a supplier is entered once.',
  'The tax and bank details are collected now because paying suppliers is being built next and will need every one of them. Nothing on this screen calculates with them yet.',
  'A supplier is never deleted — switching one off keeps its purchase history readable, which is what a payment will later be matched against.',
];

export const SUPPLIER_ACTIVITY_ABOUT_TITLE = 'About supplier activity';

export const SUPPLIER_ACTIVITY_ABOUT = [
  'What this hotel has ordered from this supplier and what has arrived. It is not an account and it does not show a balance.',
  'That is deliberate rather than missing. Receiving goods increases what the hotel owes, and there is no way to record a payment yet — so a figure called “owed” here would be correct until the first payment and quietly wrong from then on. Supplier payments are the next shipment, and this view gains its second side with them.',
];

// ---------------------------------------------------------------------------
// The per-figure notes (rule 16: every summary says how it was calculated, and
// rule 20: it says that it covers the whole filtered set, not the page)
// ---------------------------------------------------------------------------

export const ORDERED_VALUE_NOTE =
  'Every order matching the filters above — all pages, not just this one — valued at the prices you ordered at. Includes cancelled orders unless you filter them out.';

export const RECEIVED_VALUE_NOTE =
  'What has actually arrived against those orders, valued at the prices you were INVOICED. It can differ from the ordered value even when every quantity matched, because a supplier can charge a different price from the one you ordered at.';

export const OUTSTANDING_VALUE_NOTE =
  'What is still expected on open orders matching the filters, at the ordered prices — nothing has been invoiced for it yet. Lines closed short count as nothing outstanding.';

export const OPEN_COUNT_NOTE =
  'Orders that have been sent and still have something outstanding, across the whole filtered set.';

// ---------------------------------------------------------------------------
// Empty states — NOT teaching, and they stay on the screen (rule 25)
// ---------------------------------------------------------------------------

export const NO_ORDERS_YET =
  'No purchase orders yet. The first one starts above.';

export const NO_ORDERS_MATCH =
  'No purchase orders match these filters.';

export const NO_SUPPLIERS_YET =
  'No suppliers yet. Add the first one above, then you can raise an order.';

export const NO_SUPPLIERS_MATCH = 'No suppliers match these filters.';

export const NO_ACTIVITY_YET =
  'Nothing ordered from this supplier at this property yet.';

export const NOTHING_OUTSTANDING =
  'Everything on this order has arrived or been closed short.';
