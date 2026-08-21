import { useEffect, useState } from 'react';
import { Pagination } from '../../ui/Pagination';
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
  type DirectReceiptRow,
  type LateOpeningRow,
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

      <LateOpenings
        key={`openings:${filters.fromDate}|${filters.toDate}`}
        tenantId={tenantId}
        propertyId={propertyId}
        currency={currency}
        filters={filters}
      />

      {/* THE THIRD QUESTION, as a way in rather than a second table. */}
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
      <table className="w-full min-w-[52rem] border-collapse text-xs">
        <thead>
          <tr className="border-b border-sand-border text-left">
            <Th>Date</Th>
            <Th>Item</Th>
            <Th>Went to</Th>
            <Th right>Quantity</Th>
            <Th right>Value</Th>
            <Th>Supplier</Th>
            <Th>Why</Th>
            <Th>Authorised by</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => (
            <tr key={row.id}>
              <Td>{formatDisplayDate(row.business_date)}</Td>
              <Td strong>
                {row.item_name}
                {row.item_code ? (
                  <span className="block text-charcoal-muted">{row.item_code}</span>
                ) : null}
              </Td>
              <Td>{row.location_name}</Td>
              <Td right>
                {formatQuantity(row.quantity)} {row.base_unit}
              </Td>
              <Td right>{formatMoney(row.receipt_value, currency)}</Td>
              <Td>{row.supplier ?? MISSING_VALUE}</Td>
              {/* THE ANSWER, beside the question. Without this column the screen
                  would generate a conversation per row. */}
              <Td>{row.reason ?? MISSING_VALUE}</Td>
              <Td>{staffLabel(row.authorised_by, userId)}</Td>
            </tr>
          ))}
        </tbody>
      </table>
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
      <table className="w-full min-w-[48rem] border-collapse text-xs">
        <thead>
          <tr className="border-b border-sand-border text-left">
            <Th>Dated</Th>
            <Th>Item</Th>
            <Th>Location</Th>
            <Th right>Quantity</Th>
            <Th right>Value</Th>
            <Th>Already in use since</Th>
            <Th>Note</Th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => (
            <tr key={row.id}>
              <Td>{formatDisplayDate(row.business_date)}</Td>
              <Td strong>
                {row.item_name}
                {row.item_code ? (
                  <span className="block text-charcoal-muted">{row.item_code}</span>
                ) : null}
              </Td>
              <Td>{row.location_name}</Td>
              <Td right>
                {formatQuantity(row.quantity)} {row.base_unit}
              </Td>
              <Td right>{formatMoney(row.opening_value, currency)}</Td>
              {/* WHAT WAS ALREADY HAPPENING THERE — the fact that turns a flag
                  into a question somebody can answer. */}
              <Td>
                {formatDisplayDate(row.first_movement_date)}
                <span className="block text-charcoal-muted">
                  a {movementTypeLabel(row.first_movement_type as never).toLowerCase()}
                </span>
              </Td>
              <Td>{row.note ?? MISSING_VALUE}</Td>
            </tr>
          ))}
        </tbody>
      </table>
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

function Th({ children, right = false }: { children: React.ReactNode; right?: boolean }) {
  return (
    <th
      scope="col"
      className={`py-1.5 pr-3 font-semibold whitespace-nowrap text-charcoal-muted ${
        right ? 'text-right' : ''
      }`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  right = false,
  strong = false,
}: {
  children: React.ReactNode;
  right?: boolean;
  strong?: boolean;
}) {
  return (
    <td
      className={`py-2 pr-3 align-top ${right ? 'text-right tabular-nums' : ''} ${
        strong ? 'font-medium text-charcoal' : 'text-charcoal-muted'
      }`}
    >
      {children}
    </td>
  );
}
