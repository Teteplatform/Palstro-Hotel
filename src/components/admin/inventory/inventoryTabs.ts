// THE TAB ROW, DEFINED ONCE AS DATA — the same convention as adminNav.ts, and
// for the same reason: settling the FULL shape now means the tranches still to
// come slot in by flipping a `status`, not by restructuring the page.
//
// Generic UI copy, never tenant content (rule 17).
//
// A 'soon' tab is NOT a dead link and NOT a fake screen. It renders a panel that
// says plainly what the tab will do, what has to exist first, and what to use in
// the meantime. That is the honest half of showing the shape of the finished
// product: the owner can see where a feature will live without being shown a
// table of numbers nobody computed.
//
// ---------------------------------------------------------------------------
// WHAT LEFT THIS ROW, AND WHY
// ---------------------------------------------------------------------------
// REQUISITIONS is now its own sidebar entry (adminNav.ts), a sibling of
// Inventory rather than a tab inside it. A requisition is a conversation between
// two locations with an approval in the middle — the kitchen asks, the store
// sends, the kitchen confirms what arrived — which makes it a module with its
// own screens and its own pending queue, not a view of the stock list. Leaving
// it as a tab would have meant rebuilding it as a page the moment it was real.
//
// STOCK TRANSFERS went with it, because a transfer IS the second half of a
// requisition: the same two-sided movement, the same permissions question, the
// same engine. Two placeholders describing one unbuilt feature is one placeholder
// too many, so transfers are explained on the Requisitions page instead. This tab
// row now contains only tabs that work — with the single exception below, which
// has nowhere else to explain itself.

export type InventoryTabKey =
  | 'products'
  | 'categories'
  | 'adjustments'
  | 'stock_take'
  | 'price_update'
  | 'import_history';

export interface InventoryTab {
  key: InventoryTabKey;
  label: string;
  status: 'ready' | 'soon';
  // Shown on the placeholder panel: what the tab will do, what must exist first,
  // and what to do until then. All three, or the panel is just a shrug.
  soonSummary?: string;
  soonDetail?: string;
  soonNeeds?: string[];
  soonMeanwhile?: string;
}

export const INVENTORY_TABS: InventoryTab[] = [
  { key: 'products', label: 'Products', status: 'ready' },
  { key: 'categories', label: 'Categories', status: 'ready' },
  { key: 'adjustments', label: 'Adjustments', status: 'ready' },
  { key: 'stock_take', label: 'Stock Take', status: 'ready' },
  { key: 'import_history', label: 'Import History', status: 'ready' },
  // KEPT AS A TAB, unlike transfers and requisitions, for one reason: selling
  // prices arrive with Food and Beverage, and that module is a disabled entry in
  // the sidebar with no page behind it — so there is nowhere else this could
  // explain itself. It stays here, saying exactly what it needs, until the menu
  // exists to own it.
  {
    key: 'price_update',
    label: 'Price Update',
    status: 'soon',
    soonSummary:
      'Set and change what you CHARGE for the things you sell — the bar list and the menu, repriced in one place.',
    soonDetail:
      'Nothing in this system has a selling price yet, and this page will not ' +
      'invent one. What Inventory holds is what stock COST you: the moving ' +
      'average built from your opening balances and, later, your purchases. ' +
      'That is a different number from what you sell it for, and it is never ' +
      'guessed from a price or a margin — the gap between the two is the ' +
      'variance report this whole module exists to produce, so deriving one ' +
      'from the other would quietly delete the answer.',
    soonNeeds: [
      'The Food and Beverage module, which is where a menu item and a bar list line live.',
      'A selling price on those lines — the thing this page edits.',
      'Recipes, so a plated dish knows which stock its price is set against.',
    ],
    soonMeanwhile:
      'Cost per unit is already here and already correct: open any item on the ' +
      'Products tab to see its average cost and every movement behind it. Sell ' +
      'prices are quoted outside the system until the menu arrives.',
  },
];
