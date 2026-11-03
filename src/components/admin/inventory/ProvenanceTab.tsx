import { useEffect, useState } from 'react';
import { Pagination } from '../../ui/Pagination';
import { DataTable, type DataColumn } from '../../ui/DataTable';
import { ScreenHeader } from '../../ui/ScreenHeader';
import { DateField } from '../../ui/form';
import { formatDisplayDate, formatDisplayDateTimeInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatQuantity, MISSING_VALUE } from '../../../lib/format';
import { staffLabel } from '../../../lib/staffLabel';
import { movementTypeLabel } from '../../../lib/stockLabels';
import {
  EMPTY_PROVENANCE_FILTERS,
  fetchDirectReceiptsPage,
  fetchLateOpeningsPage,
  fetchOverReceiptsPage,
  type DirectReceiptRow,
  type LateOpeningRow,
  type OverReceiptRow,
  type ProvenanceFilters,
} from '../../../lib/stockProvenance';
import {
  PROVENANCE_ABOUT,
  PROVENANCE_ABOUT_TITLE,
} from '../../../lib/stockLabels';
import { useAuth } from '../../../hooks/useAuth';

// THINGS THAT DID NOT COME THROUGH THE FRONT DOOR (1.1g §4).
//
// ---------------------------------------------------------------------------
// QUESTIONS, NOT ACCUSATIONS — and the wording is the feature
// ---------------------------------------------------------------------------
// Every row on this screen has an innocent explanation and most of them are
// innocent. A direct receipt is usually a real delivery that really did go
// straight to the bar. A late opening balance is usually somebody adding an item
// they forgot to set up. A negative is usually a delivery nobody keyed.
//
// A screen that called these "exceptions" or "violations" would be read as an
// allegation, and the first time a manager was asked to explain a row they had a
// perfectly good reason for, they would stop using the feature that produced it —
// which is how a control gets routed around rather than followed. So each section
// says what it IS, in plain words, and carries the ANSWER alongside the question:
// who authorised it, what reason they gave, what was already happening there.
// Most rows explain themselves without anybody being asked.
//
// ---------------------------------------------------------------------------
// THE THIRD SECTION IS A LINK, NOT A THIRD TABLE
// ---------------------------------------------------------------------------
// Negative positions already have a screen — the Negative Stock tab, built in
// 038 §9 with its own filters, its own summary and its own export. Rebuilding a
// cut-down version here would be a second implementation of "what is negative",
// and the day the two disagreed there would be no way to tell which was right.
// So this section states the count and sends you there.

interface ProvenanceTabProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  currency: string;
  timezone: string;
  // The count from the negative-stock screen's own data, passed in rather than
  // re-queried — see the header.
  negativeCount: number | null;
  onShowNegatives: () => void;
}

const PAGE_SIZE = 25;

export function ProvenanceTab({
  tenantId,
  propertyId,
  propertySlug,
  currency,
  timezone,
  negativeCount,
  onShowNegatives,
}: ProvenanceTabProps) {
  const { user } = useAuth();
  const [filters, setFilters] = useState<ProvenanceFilters>(EMPTY_PROVENANCE_FILTERS);

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <ScreenHeader
          level={2}
          title="Stock provenance"
          purpose="Stock that did not arrive the usual way — and what was said about it."
          about={{
            title: PROVENANCE_ABOUT_TITLE,
            paragraphs: PROVENANCE_ABOUT,
            guideAnchor: 'stock-that-did-not-come-through-the-front-door',
            guideLabel: 'Stock that did not come through the front door',
          }}
          propertySlug={propertySlug}
        />

        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:max-w-md">
          <DateField
            label="From"
            value={filters.fromDate}
            onChange={(v) => setFilters((f) => ({ ...f, fromDate: v }))}
            helpText="The operating day, not the day it was keyed."
          />
          <DateField
            label="To"
            value={filters.toDate}
            onChange={(v) => setFilters((f) => ({ ...f, toDate: v }))}
          />
        </div>
      </div>

      {/* FILTER THEN PAGE, NEVER THE OTHER WAY ROUND (rule 1b) — as a REMOUNT
          KEY rather than a reset effect. Changing a date must put you back on
          page one, or you land on an empty high page of a narrower set; doing it
          with useEffect(() => setPage(1)) is a cascading render the linter
          rightly refuses, and remounting says the same thing without one. */}
      <DirectReceipts
        key={`receipts:${filters.fromDate}|${filters.toDate}`}
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        timezone={timezone}
        filters={filters}
        userId={user?.id ?? null}
      />

      {/* THE FOURTH QUESTION (049). The three around it are all "did this stock
          arrive in the right PLACE"; this one is "did this much of it arrive",
          which is the same question asked of a different column — and the only
          other act in the product that spends a manager's PIN. */}
      <OverReceipts
        key={`over:${filters.fromDate}|${filters.toDate}`}
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        filters={filters}
        userId={user?.id ?? null}
      />

      <LateOpenings
        key={`openings:${filters.fromDate}|${filters.toDate}`}
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        filters={filters}
      />

      {/* THE LAST QUESTION, as a way in rather than another table. */}
      <section className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <h3 className="text-sm font-semibold text-charcoal">
          Stock showing less than nothing
        </h3>
        <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
          A negative position means stock left without a movement behind it — a
          delivery nobody entered, an issue posted against the wrong location, or
          stock that walked.
        </p>
        <div className="mt-3">
          {negativeCount === null ? (
            <span className="text-sm text-charcoal-muted" aria-live="polite">
              Counting…
            </span>
          ) : negativeCount === 0 ? (
            <span className="text-sm text-charcoal-muted">
              Nothing is negative right now.
            </span>
          ) : (
            <button
              type="button"
              onClick={onShowNegatives}
              className="rounded-full bg-accent/15 px-3 py-1.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/25 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
            >
              {negativeCount} {negativeCount === 1 ? 'position is' : 'positions are'} below
              zero — open the full list →
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Direct receipts
// ---------------------------------------------------------------------------

function DirectReceipts({
  tenantId,
  propertyId,
  currency,
  timezone,
  filters,
  userId,
}: {
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  filters: ProvenanceFilters;
  userId: string | null;
}) {
  const [rows, setRows] = useState<DirectReceiptRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { fromDate, toDate } = filters;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchDirectReceiptsPage(
          tenantId, propertyId, page, pageSize, { fromDate, toDate },
        );
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return; // the effect re-runs; stay loading
        }
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(describeError(e)); // rule 11
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, page, pageSize, fromDate, toDate]);

  return (
    <Section
      title="Delivered somewhere other than a store"
      lead="Goods normally arrive in a store and reach a kitchen or a bar by being issued from it. These went straight there, with a manager’s authority."
      count={count}
      loading={loading}
      error={error}
      empty="No deliveries have gone anywhere other than a store."
    >
      <DataTable
        columns={directReceiptColumns(currency, userId)}
        rows={rows}
        rowKey={(row) => row.id}
        minWidthClass="min-w-[52rem]"
        textClass="text-xs"
        tableClassName="border-collapse"
        headerRowClassName="border-b border-sand-border text-left"
        bodyClassName="divide-y divide-sand-border/50"
        rowClassName={() => ''}
        cardListLabel="Deliveries that did not go to a store"
      />
      <p className="mt-2 text-[11px] text-charcoal-muted">
        Recorded {rows.length > 0
          ? formatDisplayDateTimeInZone(rows[0].created_at, timezone)
          : ''}
        {rows.length > 1 ? ' and earlier' : ''}
      </p>
      <Pagination
        page={page}
        pageSize={pageSize}
        totalCount={count}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={loading}
        itemNoun="deliveries"
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Over-receipts (049) — more arrived than was ordered, and a manager said yes
// ---------------------------------------------------------------------------
// WHY THIS IS A SECTION AND NOT A NOTE ON THE ORDER. The order page now names
// the authoriser on its deliveries table, which answers "who approved THIS".
// The owner's question is the other one — "what did we accept this month that
// nobody ordered" — and that cannot be answered one order at a time.
//
// It carries the reason column for the same purpose the direct-receipt section
// does: most of these are a supplier sending a full carton instead of a part
// one, and a report that forces a conversation per row is a report that stops
// being read.

function OverReceipts({
  tenantId,
  propertyId,
  currency,
  filters,
  userId,
}: {
  tenantId: string;
  propertyId: string;
  currency: string;
  filters: ProvenanceFilters;
  userId: string | null;
}) {
  const [rows, setRows] = useState<OverReceiptRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { fromDate, toDate } = filters;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchOverReceiptsPage(
          tenantId, propertyId, page, pageSize, { fromDate, toDate },
        );
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return; // the effect re-runs; stay loading
        }
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(describeError(e)); // rule 11
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, page, pageSize, fromDate, toDate]);

  return (
    <Section
      title="More arrived than was ordered"
      lead="A delivery can only be accepted above what the order asked for with a manager’s PIN. These are the ones that were, and what the hotel took on by accepting them."
      count={count}
      loading={loading}
      error={error}
      empty="Nothing has been accepted above what was ordered."
    >
      <OverReceiptsTable rows={rows} currency={currency} userId={userId} />
      <Pagination
        page={page}
        pageSize={pageSize}
        totalCount={count}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={loading}
        itemNoun="deliveries"
      />
    </Section>
  );
}

// EXTRACTED RATHER THAN COPIED (rule 22): the render proof drives THIS, the
// table the screen runs, so the proof cannot drift away from the thing it is
// proving. The fetching stays in the section above it, where a proof has no
// business going.
export function OverReceiptsTable({
  rows,
  currency,
  userId,
}: {
  rows: OverReceiptRow[];
  currency: string;
  userId: string | null;
}) {
  return (
      <DataTable
        columns={overReceiptColumns(currency, userId)}
        rows={rows}
        rowKey={(row) => row.id}
        minWidthClass="min-w-[56rem]"
        textClass="text-xs"
        tableClassName="border-collapse"
        headerRowClassName="border-b border-sand-border text-left"
        bodyClassName="divide-y divide-sand-border/50"
        rowClassName={() => ''}
        cardListLabel="Deliveries accepted above what was ordered"
      />
  );
}

// ---------------------------------------------------------------------------
// Late openings
// ---------------------------------------------------------------------------

function LateOpenings({
  tenantId,
  propertyId,
  currency,
  filters,
}: {
  tenantId: string;
  propertyId: string;
  currency: string;
  filters: ProvenanceFilters;
  // NO userId — unlike a direct receipt, a late opening has no authoriser to
  // name. It was posted by somebody, which created_by records, but nobody
  // approved it, because there was no exception to approve at the time.
}) {
  const [rows, setRows] = useState<LateOpeningRow[]>([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { fromDate, toDate } = filters;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const result = await fetchLateOpeningsPage(
          tenantId, propertyId, page, pageSize, { fromDate, toDate },
        );
        if (cancelled) return;
        const lastPage = Math.max(1, Math.ceil(result.count / pageSize));
        if (page > lastPage) {
          setPage(lastPage);
          return;
        }
        setRows(result.rows);
        setCount(result.count);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(describeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, page, pageSize, fromDate, toDate]);

  // No page-reset effect here either — the parent's remount key does it.

  return (
    <Section
      title="Declared as opening stock in a place already in use"
      lead="An opening balance says “this is what was here when we started”. These were entered after that location had already been working, so the stock arrived from somewhere the ledger does not show."
      count={count}
      loading={loading}
      error={error}
      empty="Every opening balance was entered before its location started being used."
    >
      <DataTable
        columns={lateOpeningColumns(currency)}
        rows={rows}
        rowKey={(row) => row.id}
        minWidthClass="min-w-[48rem]"
        textClass="text-xs"
        tableClassName="border-collapse"
        headerRowClassName="border-b border-sand-border text-left"
        bodyClassName="divide-y divide-sand-border/50"
        rowClassName={() => ''}
        cardListLabel="Opening balances in a location already in use"
      />
      <Pagination
        page={page}
        pageSize={pageSize}
        totalCount={count}
        onPageChange={setPage}
        onPageSizeChange={setPageSize}
        disabled={loading}
        itemNoun="openings"
      />
    </Section>
  );
}

// ---------------------------------------------------------------------------
// The shared section shell
// ---------------------------------------------------------------------------
// One shape for both, so the two questions read as two questions rather than as
// two screens that happen to be adjacent.
function Section({
  title,
  lead,
  count,
  loading,
  error,
  empty,
  children,
}: {
  title: string;
  lead: string;
  count: number;
  loading: boolean;
  error: string | null;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-sand-border bg-white/60">
      <div className="border-b border-sand-border px-4 py-3">
        <h3 className="text-sm font-semibold text-charcoal">
          {title}
          {!loading && count > 0 ? (
            <span className="ml-2 font-normal text-charcoal-muted">{count}</span>
          ) : null}
        </h3>
        {/* ONE LINE PER SECTION, and it is not teaching — it says what the rows
            in front of you ARE, which is what a person needs to read them. */}
        <p className="mt-0.5 max-w-3xl text-xs text-charcoal-muted">{lead}</p>
      </div>

      {error ? (
        <p className="px-4 py-6 text-sm text-charcoal">These could not be loaded: {error}</p>
      ) : loading ? (
        <p className="px-4 py-6 text-sm text-charcoal-muted" aria-live="polite">
          Loading…
        </p>
      ) : count === 0 ? (
        // An empty state that says what it means, rather than "no results".
        <p className="px-4 py-8 text-center text-sm text-charcoal-muted">{empty}</p>
      ) : (
        <div className="overflow-x-auto px-4 py-3">{children}</div>
      )}
    </section>
  );
}


// ---------------------------------------------------------------------------
// The column specs (1.1a2's follow-up)
// ---------------------------------------------------------------------------
// THESE THREE TABLES ARE THE SAME SHAPE AS PURCHASING'S SEVEN and were left out
// of 1.1a2 only because they are not purchasing screens — including the
// over-receipt table 049 added, which would have been a poor one to leave as the
// odd one out given it is the newest. They are read-only, so the consequence on
// a phone is annoyance rather than danger, but the argument for converting them
// is the one that applied to the seven: the reason tables share a defect is that
// they were written separately, and the odd one out is the one nobody tests.
//
// The look is carried across verbatim — text-xs, a divided tbody, the heavier
// header — so above the breakpoint nothing about these screens changed.
const TH_CLASS = 'py-1.5 pr-3 font-semibold whitespace-nowrap text-charcoal-muted';
const TD_CLASS = 'py-2 pr-3 align-top text-charcoal-muted';
const TD_RIGHT_CLASS = 'py-2 pr-3 align-top text-right tabular-nums text-charcoal-muted';
const TD_STRONG_CLASS = 'py-2 pr-3 align-top font-medium text-charcoal';

function itemCell(name: string | null, code: string | null) {
  return (
    <>
      {name ?? MISSING_VALUE}
      {code ? <span className="block text-charcoal-muted">{code}</span> : null}
    </>
  );
}

function directReceiptColumns(
  currency: string,
  userId: string | null,
): DataColumn<DirectReceiptRow>[] {
  return [
    {
      key: 'date',
      header: 'Date',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => formatDisplayDate(row.business_date),
    },
    {
      key: 'item',
      role: 'heading',
      header: 'Item',
      headerClassName: TH_CLASS,
      cellClassName: TD_STRONG_CLASS,
      cell: (row) => itemCell(row.item_name, row.item_code),
    },
    {
      key: 'wentTo',
      header: 'Went to',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.location_name,
    },
    {
      key: 'quantity',
      header: 'Quantity',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => (
        <>
          {formatQuantity(row.quantity)} {row.base_unit}
        </>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => formatMoney(row.receipt_value, currency),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.supplier ?? MISSING_VALUE,
    },
    {
      // THE ANSWER, beside the question. Without this column the screen would
      // generate a conversation per row.
      key: 'why',
      header: 'Why',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.reason ?? MISSING_VALUE,
    },
    {
      key: 'authorised',
      header: 'Authorised by',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => staffLabel(row.authorised_by, userId),
    },
  ];
}

function overReceiptColumns(
  currency: string,
  userId: string | null,
): DataColumn<OverReceiptRow>[] {
  return [
    {
      key: 'date',
      header: 'Date',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => formatDisplayDate(row.business_date),
    },
    {
      key: 'item',
      role: 'heading',
      header: 'Item',
      headerClassName: TH_CLASS,
      cellClassName: TD_STRONG_CLASS,
      cell: (row) => itemCell(row.item_name, row.item_code),
    },
    {
      key: 'delivery',
      header: 'Delivery',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => (
        <>
          {row.receipt_number}
          <span className="block text-charcoal-muted">{row.order_number}</span>
        </>
      ),
    },
    {
      key: 'supplier',
      header: 'Supplier',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.supplier_name,
    },
    {
      // ORDERED is the whole line's figure and ARRIVED is THIS delivery's,
      // which is the pair somebody needs to see the shape of: 20 ordered, 25
      // came. OVER BY is the part of this delivery above the line, so two
      // deliveries past it do not both claim the whole excess.
      key: 'ordered',
      header: 'Ordered',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => (
        <>
          {formatQuantity(row.ordered_quantity)} {row.base_unit ?? ''}
        </>
      ),
    },
    {
      key: 'arrived',
      header: 'Arrived',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => (
        <>
          {formatQuantity(row.quantity)} {row.base_unit ?? ''}
        </>
      ),
    },
    {
      key: 'overBy',
      header: 'Over by',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => (
        <span className="font-semibold text-amber-800">
          +{formatQuantity(row.over_quantity)} {row.base_unit ?? ''}
        </span>
      ),
    },
    {
      key: 'overValue',
      header: 'Cost of the extra',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => formatMoney(row.over_value, currency),
    },
    {
      key: 'why',
      header: 'Why',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.reason ?? MISSING_VALUE,
    },
    {
      // THE PROMISE THE PIN DIALOG MAKES, kept where somebody can read it.
      key: 'authorised',
      header: 'Authorised by',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => staffLabel(row.authorised_by, userId),
    },
  ];
}

function lateOpeningColumns(currency: string): DataColumn<LateOpeningRow>[] {
  return [
    {
      key: 'dated',
      header: 'Dated',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => formatDisplayDate(row.business_date),
    },
    {
      key: 'item',
      role: 'heading',
      header: 'Item',
      headerClassName: TH_CLASS,
      cellClassName: TD_STRONG_CLASS,
      cell: (row) => itemCell(row.item_name, row.item_code),
    },
    {
      key: 'location',
      header: 'Location',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.location_name,
    },
    {
      key: 'quantity',
      header: 'Quantity',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => (
        <>
          {formatQuantity(row.quantity)} {row.base_unit}
        </>
      ),
    },
    {
      key: 'value',
      header: 'Value',
      align: 'right',
      headerClassName: TH_CLASS,
      cellClassName: TD_RIGHT_CLASS,
      cell: (row) => formatMoney(row.opening_value, currency),
    },
    {
      // WHAT WAS ALREADY HAPPENING THERE — the fact that turns a flag into a
      // question somebody can answer.
      key: 'inUseSince',
      header: 'Already in use since',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => (
        <>
          {formatDisplayDate(row.first_movement_date)}
          <span className="block text-charcoal-muted">
            a {movementTypeLabel(row.first_movement_type as never).toLowerCase()}
          </span>
        </>
      ),
    },
    {
      key: 'note',
      header: 'Note',
      headerClassName: TH_CLASS,
      cellClassName: TD_CLASS,
      cell: (row) => row.note ?? MISSING_VALUE,
    },
  ];
}
