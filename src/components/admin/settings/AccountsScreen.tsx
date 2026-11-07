import { useState } from 'react';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { ChartOfAccountsTab } from './ChartOfAccountsTab';
import { MappingsTab } from './AccountsPanel';
import { ChargeCategoriesTab } from './ChargeCategoriesTab';
import { InventoryReconciliationPanel } from './InventoryReconciliationPanel';

// THE ACCOUNTS SCREEN (1.1h1) — one page, two tabs, one ⓘ.
//
// ---------------------------------------------------------------------------
// WHY THIS SHELL EXISTS AT ALL
// ---------------------------------------------------------------------------
// 1.1h shipped a mapping screen and called it the accounts screen. Those are two
// different objects and an accountant opens the other one first:
//
//   * THE CHART OF ACCOUNTS — the list. 1000 Cash, 1010 Bank, 4000 Room
//     revenue, grouped the way a financial statement is grouped. What a hotel
//     reads, prints and hands to an auditor. A trial balance is just this list
//     with balances on it, which is why it cannot wait for stage 11: if the list
//     is wrong, every statement built on it is wrong.
//   * WHERE MONEY POSTS — role key to account. What shipped. Correct, and
//     secondary.
//
// The chart is the DEFAULT tab, because it is the thing being opened.
//
// ---------------------------------------------------------------------------
// ONE ScreenHeader, HERE, AND NOT ONE PER TAB
// ---------------------------------------------------------------------------
// Rule 25: the ⓘ is one icon, one panel, all of it — "not three tooltips in
// three places". Two ScreenHeaders on one page would be two ⓘs disagreeing about
// which one holds the explanation. So the header lives on the shell, the tabs
// render their controls and nothing above them, and MappingsTab had its own
// header removed when it was demoted.

interface AccountsScreenProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  // The property's own currency, never a literal (rule 17). Only the
  // reconciliation tab needs it, and it comes down rather than being read again.
  currency: string;
  canEdit: boolean;
}

type TabId = 'chart' | 'mappings' | 'categories' | 'reconciliation';

const TABS: { id: TabId; label: string }[] = [
  { id: 'chart', label: 'Chart of accounts' },
  { id: 'mappings', label: 'Where money posts' },
  // 1.1h4 item 10. THE FOURTH TAB IS HERE BECAUSE THE DATABASE SAID SO. 044's
  // trigger has refused a charge category with no revenue account since the day
  // it shipped, and its hint reads "Open Settings, then Accounts, and choose the
  // revenue account for this category" — naming a destination that did not
  // exist. Rule 21 makes the hint the interface, so the tab goes where the hint
  // already points rather than somewhere that would make the hint wrong.
  //
  // It sits AFTER "Where money posts" on purpose: a category chooses a role key,
  // and the tab before it is where a key is pointed at an account. Reading left
  // to right is the order you have to do them in on a fresh hotel.
  { id: 'categories', label: 'Charge categories' },
  // 1.1h2. THE THIRD TAB IS THE ONE THAT SAYS WHETHER THE OTHER TWO ARE
  // WORKING. A chart is a list and a mapping is an intention; this is the only
  // place that reports whether the money actually went where the mapping says.
  { id: 'reconciliation', label: 'Does it agree?' },
];

export function AccountsScreen({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  canEdit,
}: AccountsScreenProps) {
  const [tab, setTab] = useState<TabId>('chart');

  return (
    <div>
      <ScreenHeader
        level={2}
        title="Accounts"
        purpose="Your chart of accounts, and where each kind of money posts to it."
        about={{
          title: 'The chart, and the wiring',
          paragraphs: [
            'The chart of accounts is your list: every account the hotel keeps, numbered and grouped the way a financial statement is grouped. Assets, liabilities, equity, revenue, expenses. Add to it freely — three banks need three accounts.',
            'Accounts are ordered by their number, inside their group. Assets run 1000–1999, liabilities 2000–2999, equity 3000–3999, revenue 4000–4999, expenses 5000–5999. An account you add lands where its number puts it, so the numbering is the ordering and there is nothing else to keep in step.',
            'Nothing in this system knows an account number. Every posting names a role key — "guest ledger", "stock on hand", "rooms" — and the second tab is where each key is pointed at one of your accounts. That is why you can renumber your chart, rename an account, or hand the books to a new accountant without anything breaking.',
            'An account you have already posted to keeps its number for good, because that number is what your printed statements and your auditor cite. Renaming stays free, always, and every entry stays attached. An account nothing has posted to can be renumbered freely.',
            'Switching an account off stops it being offered for new postings and keeps it on the chart, so past reports still balance. You cannot switch one off while a role key still posts to it — repoint the key first, on the second tab.',
            'There are no sub-groups inside the five sections, and no group headers. Current versus non-current assets, direct versus overhead costs: a 30-room hotel does not need that, and it is left out on purpose rather than forgotten.',
            'One thing the second tab does NOT do: each role key names ONE account. Three bank accounts can sit on your chart today, and the "bank" key points at one of them. Choosing which bank a particular transfer landed in is a decision on the payment screen, and it arrives with cashiering.',
            'The third tab is your charge categories: what the desk may bill for, and which revenue account each kind of charge lands in. A category names a role key, exactly as a posting does, so the tab before it is where that key is pointed at an account — on a new hotel you do those in that order. Every category must name where it posts; there is no default, because revenue landing somewhere nobody chose is the one thing this screen exists to prevent.',
            'Miscellaneous is a real choice and not a fallback. It is offered last, it resolves to Other revenue, and it is there so a genuine one-off has an honest home instead of being billed to Laundry at eleven at night. If Other revenue ever carries a material amount in a month, the charges inside it have earned categories of their own.',
            'A category’s code is set once and never changes: charges keep it, so renaming the code would repoint bills that have already been printed. The NAME is free to change whenever you like. Switching a category off takes it off the desk’s list and leaves every charge that used it exactly where it is.',
          ],
          guideAnchor: 'accounts',
          guideLabel: 'Accounts and postings',
        }}
        propertySlug={propertySlug}
      />

      <div
        role="tablist"
        aria-label="Accounts sections"
        className="mb-5 flex gap-1 border-b border-sand-border"
      >
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setTab(t.id)}
              className={`-mb-px shrink-0 whitespace-nowrap border-b-2 px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                active
                  ? 'border-primary text-charcoal'
                  : 'border-transparent text-charcoal-muted hover:text-charcoal'
              }`}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {tab === 'chart' ? (
        <ChartOfAccountsTab tenantId={tenantId} canEdit={canEdit} />
      ) : tab === 'mappings' ? (
        <MappingsTab
          tenantId={tenantId}
          propertyId={propertyId}
          canEdit={canEdit}
        />
      ) : tab === 'categories' ? (
        <ChargeCategoriesTab tenantId={tenantId} canEdit={canEdit} />
      ) : (
        <InventoryReconciliationPanel
          propertyId={propertyId}
          currency={currency}
        />
      )}
    </div>
  );
}
