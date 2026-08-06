// THE TAB ROW, DEFINED ONCE AS DATA — the same convention as adminNav.ts, and
// for the same reason: settling the FULL shape now means the tranches still to
// come slot in by flipping a `status`, not by restructuring the page.
//
// Generic UI copy, never tenant content (rule 17).
//
// A 'soon' tab is NOT a dead link and NOT a fake screen. It renders a panel that
// says plainly what the tab will do, what has to exist first, and what to use in
// the meantime. That is the honest half of showing the shape of the finished
// product: the owner can see where transfers will live without being shown a
// table of numbers nobody computed.

export type InventoryTabKey =
  | 'products'
  | 'categories'
  | 'adjustments'
  | 'transfers'
  | 'stock_take'
  | 'price_update'
  | 'import_history'
  | 'requisitions';

export interface InventoryTab {
  key: InventoryTabKey;
  label: string;
  status: 'ready' | 'soon';
  // Shown on the placeholder panel: what the tab will do, and what it waits on.
  soonSummary?: string;
  soonDetail?: string;
  // Reserves the spot for the pending-requisition count. The badge itself needs
  // the staff/roles layer to know whose approval is pending, so there is no
  // number here and deliberately no invented one.
  reservesBadge?: boolean;
}

export const INVENTORY_TABS: InventoryTab[] = [
  { key: 'products', label: 'Products', status: 'ready' },
  { key: 'categories', label: 'Categories', status: 'ready' },
  { key: 'adjustments', label: 'Adjustments', status: 'ready' },
  {
    key: 'transfers',
    label: 'Stock Transfers',
    status: 'soon',
    soonSummary: 'Move stock from one location to another.',
    soonDetail:
      'A transfer is two movements, not one — stock leaving the store and the ' +
      'same stock arriving in the kitchen — so it needs the issue and transfer ' +
      'movement types, which are reserved and have no way to be written yet. ' +
      'Until then, moving stock between locations is two adjustments: remove it ' +
      'from one, add it to the other, with the same reason on both.',
  },
  { key: 'stock_take', label: 'Stock Take', status: 'ready' },
  {
    key: 'price_update',
    label: 'Price Update',
    status: 'soon',
    soonSummary: 'Set and change what you charge for what you sell.',
    soonDetail:
      'Nothing in this system has a selling price yet. Prices belong to the menu ' +
      'and the bar list, which arrive with food and beverage; this page shows ' +
      'what stock COST you, which is a different number and is never guessed ' +
      'from a price.',
  },
  { key: 'import_history', label: 'Import History', status: 'ready' },
  {
    key: 'requisitions',
    label: 'Requisitions',
    status: 'soon',
    reservesBadge: true,
    soonSummary: 'The kitchen asks the store for what it needs, and gets it.',
    soonDetail:
      'A requisition is a request, an approval and an issue — so it needs to ' +
      'know who may request, who may approve, and for which location. That is ' +
      'the staff and roles layer, which is not built yet. The count of requests ' +
      'waiting on you will appear on this tab once it is.',
  },
];
