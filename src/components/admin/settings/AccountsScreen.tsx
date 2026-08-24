import { useState } from 'react';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { ChartOfAccountsTab } from './ChartOfAccountsTab';
import { MappingsTab } from './AccountsPanel';

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
  canEdit: boolean;
}

type TabId = 'chart' | 'mappings';

const TABS: { id: TabId; label: string }[] = [
  { id: 'chart', label: 'Chart of accounts' },
  { id: 'mappings', label: 'Where money posts' },
];

export function AccountsScreen({
  tenantId,
  propertyId,
  propertySlug,
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
      ) : (
        <MappingsTab
          tenantId={tenantId}
          propertyId={propertyId}
          canEdit={canEdit}
        />
      )}
    </div>
  );
}
