import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import { Pagination } from '../../ui/Pagination';
import { CalculationNote } from '../../ui/CalculationNote';
import { Select, TextField } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { ChevronDownIcon } from '../../ui/icons';
import { ManagerPinField } from '../ManagerPinField';
import { useStockTakeSheet } from '../../../hooks/useStockTakeSheet';
import { formatDisplayDate } from '../../../lib/date';
import { formatQuantity, parseNumeric } from '../../../lib/format';
import {
  cancelStockTake,
  fetchTakeProgress,
  finishStockTake,
  newIdempotencyKey,
  recordCountLine,
  STOCK_NEEDS_CONFIRMATION,
  stockErrorCode,
  stockErrorMessage,
} from '../../../lib/stockTake';
import {
  COUNT_BLIND_EXPLANATION,
  COUNT_PIN_LEAD,
  COUNT_PIN_REASON,
  COUNT_PIN_TITLE,
  COUNT_PROGRESS_EXPLANATION,
  COUNT_UNCOUNTED_EXPLANATION,
} from '../../../lib/stockTakeLabels';
import type { InventoryCategory } from '../../../types/inventory';
import type { StockTakeProgressRow, StockTakeSheetRow } from '../../../types/stockTake';

// THE OPEN COUNT SHEET — what the counter walks the store with.
//
// ---------------------------------------------------------------------------
// WHAT IS NOT ON THIS SCREEN, AND WHY THAT IS THE FEATURE
// ---------------------------------------------------------------------------
// There is no expected quantity, no variance and no value anywhere below. Not
// hidden, not collapsed behind a toggle: ABSENT FROM THE PAYLOAD. 039 §4 revokes
// the column privilege, gives stock_take_lines no select policy and NULLs the
// column in the view until the count is finished, so there is nothing here to
// render even if a future edit tried to.
//
// ---------------------------------------------------------------------------
// TWO LISTS, NOT ONE — the working list and the accordion
// ---------------------------------------------------------------------------
// "Still to count" is the job, so it is open, first, and never collapsed.
// "Already counted" is review — fixing a line keyed against the wrong shelf —
// so it is an accordion, closed by default, with its own paging. They page
// independently on purpose: opening the review list must not lose the counter's
// place in the shelves they have left.
//
// A single list with a "show" filter (which is what this was) makes the two the
// same control, so seeing what you have done means losing where you were.
//
// ---------------------------------------------------------------------------
// EVERY LINE IS SAVED WHERE IT IS TYPED
// ---------------------------------------------------------------------------
// A number goes to the server when the counter leaves the field. Nothing waits
// for a Post button, because the failure this shipment exists to fix is exactly
// the two hours of counting that vanished with a stray reload. Each save carries
// a FRESH idempotency key (a re-key is a new answer and must replace the old
// one), and the saved value is patched in from the SERVER'S OWN return value.
//
// ---------------------------------------------------------------------------
// THE PIN FIELD IS OFFERED, NEVER DEMANDED BY THIS COMPONENT
// ---------------------------------------------------------------------------
// Whether a manager must approve depends on the VALUE of the variance, which is
// the one figure this screen is forbidden to know. So the client cannot decide
// and does not try: it offers the field, sends whatever was typed, and shows the
// server's refusal verbatim when one was needed and none was given (rule 21).
//
// It also says WHAT IS BEING APPROVED, which it did not at first: the shared
// ManagerPinField hardcoded "authorise this reversal", so a storekeeper
// finishing a count was asked to approve a reversal of nothing. The act is a
// prop now.

interface CountSheetProps {
  tenantId: string;
  propertyId: string;
  propertySlug: string;
  take: StockTakeProgressRow;
  categories: InventoryCategory[];
  // Called after the count is finished or abandoned, so the page re-reads the
  // document and shows what it has become.
  onClosed: (finished: boolean) => Promise<void> | void;
}

// One row's save state. Held per line rather than for the sheet, so a failure on
// one shelf never blocks the next one.
type LineState = 'idle' | 'saving' | 'error';

export function CountSheet({
  tenantId,
  propertyId,
  propertySlug,
  take,
  categories,
  onClosed,
}: CountSheetProps) {
  const toast = useToast();

  // TWO INDEPENDENT SECTIONS (see the header). Each pages on its own; the
  // search and category filters below are pushed into both, so the two lists
  // always describe the same slice of the catalogue.
  const todo = useStockTakeSheet(tenantId, propertyId, take.stock_take_id, 'uncounted');
  const done = useStockTakeSheet(tenantId, propertyId, take.stock_take_id, 'counted');

  // The document's own figures, held ONCE for the screen and refreshed after a
  // save — not fetched per list, which would double every round trip.
  const [progress, setProgress] = useState<StockTakeProgressRow>(take);
  const [countedOpen, setCountedOpen] = useState(false);

  const [drafts, setDrafts] = useState<Map<string, string>>(new Map());
  const [states, setStates] = useState<Map<string, LineState>>(new Map());
  const [messages, setMessages] = useState<Map<string, string>>(new Map());

  const [search, setSearch] = useState('');
  const [categoryId, setCategoryId] = useState('');

  const [pin, setPin] = useState('');
  const [finishing, setFinishing] = useState(false);
  const [finishError, setFinishError] = useState<string | null>(null);
  // The server refused the finish once and asked for confirmation (041): stock
  // moved in this location while the count was running and the affected shelves
  // were counted after it moved. Holding the MESSAGE rather than a boolean is
  // the point — it names the items, and it is the server's sentence, shown
  // verbatim (rule 21).
  const [movedWarning, setMovedWarning] = useState<string | null>(null);
  // ONE key for this sheet's finish, generated at mount and reused across every
  // attempt — the refused one, the confirmation, and any retry after a PIN
  // failure. That is what stops a confirmation from posting a second set of
  // movements (036 §4.2's rule, applied to the same shape). On success the
  // sheet is replaced by the report, so it is never reused after a post.
  const [finishKey] = useState(() => newIdempotencyKey());

  const [cancelling, setCancelling] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [cancelError, setCancelError] = useState<string | null>(null);

  const categoryOptions: SelectOption[] = [
    { value: '', label: 'All categories' },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];

  const busy = finishing || cancelling;

  const refreshProgress = useCallback(async () => {
    try {
      const next = await fetchTakeProgress(tenantId, propertyId, take.stock_take_id);
      if (next) setProgress(next);
    } catch {
      // The sheet is still usable and every line is already saved; only the
      // "how much is left" figure is stale, so this must not blank the screen.
      // The next save, or a reload, corrects it.
    }
  }, [tenantId, propertyId, take.stock_take_id]);

  // Keep the two lists' filters in step with the one filter bar.
  useEffect(() => {
    todo.setFilters({ search, categoryId, counted: '' });
    done.setFilters({ search, categoryId, counted: '' });
    // The setters are stable useCallbacks; re-running on their identity would
    // loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, categoryId]);

  function setLine<T>(
    setter: Dispatch<SetStateAction<Map<string, T>>>,
    key: string,
    value: T | null,
  ) {
    setter((prev) => {
      const next = new Map(prev);
      if (value === null) next.delete(key);
      else next.set(key, value);
      return next;
    });
  }

  // Commit one line. An empty field CLEARS the line back to "not counted",
  // which is a real instruction and not a no-op — it is how a line keyed against
  // the wrong shelf is undone without writing that shelf off to zero.
  async function commit(row: StockTakeSheetRow, raw: string) {
    const trimmed = raw.trim();
    const counted = trimmed === '' ? null : parseNumeric(trimmed);
    const current = row.counted_quantity === null ? null : parseNumeric(row.counted_quantity);

    if (counted === current) {
      setLine(setDrafts, row.line_id, null);
      return;
    }

    setLine<LineState>(setStates, row.line_id, 'saving');
    setLine(setMessages, row.line_id, null);
    try {
      await recordCountLine({
        stockTakeId: take.stock_take_id,
        inventoryItemId: row.inventory_item_id,
        countedQuantity: counted,
        // Rules 2/3: a fresh key per save.
        idempotencyKey: newIdempotencyKey(),
      });
      setLine(setDrafts, row.line_id, null);
      setLine(setStates, row.line_id, null);
      // A line has just MOVED BETWEEN THE TWO LISTS, so patching it in place is
      // not enough — both lists are re-pulled. This is the one save that costs a
      // round trip, and it is unavoidable: the row no longer belongs where it is.
      await Promise.all([todo.reload(), done.reload(), refreshProgress()]);
    } catch (e) {
      // Rule 21: the server's own sentence, with its hint, shown against the
      // line it belongs to. The typed value stays in the field.
      setLine<LineState>(setStates, row.line_id, 'error');
      setLine(setMessages, row.line_id, stockErrorMessage(e));
    }
  }

  // `allowMovedStock` is true only on the second call, after a person has read
  // the server's warning and chosen to go ahead. It is never defaulted to true
  // and never remembered between counts.
  async function handleFinish(allowMovedStock = false) {
    setFinishing(true);
    setFinishError(null);
    try {
      await finishStockTake({
        stockTakeId: take.stock_take_id,
        managerPin: pin,
        idempotencyKey: finishKey,
        allowMovedStock,
      });
      toast.success(`Count ${take.take_number} finished.`);
      setMovedWarning(null);
      await onClosed(true);
    } catch (e) {
      // PT449 is "legal, but look at this first" — the server's one refusal
      // that asks a question rather than saying no. It becomes a panel with the
      // server's own words and a way to answer, not an error the user is stuck
      // behind. Everything else is an error.
      if (stockErrorCode(e) === STOCK_NEEDS_CONFIRMATION) {
        setMovedWarning(stockErrorMessage(e));
      } else {
        setFinishError(stockErrorMessage(e));
      }
    } finally {
      // The PIN is held for the length of one call and cleared whether it
      // succeeded or failed. It is never stored anywhere else.
      setPin('');
      setFinishing(false);
    }
  }

  async function handleCancel() {
    setCancelling(true);
    setCancelError(null);
    try {
      await cancelStockTake({
        stockTakeId: take.stock_take_id,
        reason: cancelReason,
        idempotencyKey: newIdempotencyKey(),
      });
      toast.success(`Count ${take.take_number} was abandoned. Nothing was posted.`);
      await onClosed(false);
    } catch (e) {
      setCancelError(stockErrorMessage(e));
    } finally {
      setCancelling(false);
    }
  }

  const rowProps = (row: StockTakeSheetRow) => ({
    row,
    draft: drafts.get(row.line_id),
    state: states.get(row.line_id) ?? ('idle' as LineState),
    message: messages.get(row.line_id) ?? null,
    disabled: busy,
    onDraftChange: (v: string) => setLine(setDrafts, row.line_id, v),
    onCommit: (v: string) => void commit(row, v),
  });

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- */}
      {/* The document header                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold text-charcoal">
              Count {take.take_number}
            </h2>
            <p className="mt-0.5 text-sm text-charcoal-muted">
              {take.location_name} ·{' '}
              {/* Rule 8/12: the operating day the count belongs to. */}
              counting {formatDisplayDate(take.business_date)}
              {take.note ? ` · ${take.note}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-accent/15 px-3 py-1 text-xs font-semibold text-accent">
              In progress
            </span>
            {/* THE PAPER. A new tab, deliberately: the person opening it is
                about to walk away from this screen with a clipboard, and taking
                the sheet they are keying into with them is the last thing they
                want. */}
            <a
              href={`/admin/${propertySlug}/inventory/counts/${take.stock_take_id}/print`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Print the count sheet
            </a>
          </div>
        </div>

        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-charcoal">
          <span className="font-semibold">{progress.counted_count}</span> counted ·{' '}
          <span className="font-semibold">{progress.uncounted_count}</span> still
          to count
          <CalculationNote note={COUNT_PROGRESS_EXPLANATION} />
        </p>

        <p className="mt-2 max-w-2xl text-xs text-charcoal-muted">
          {COUNT_BLIND_EXPLANATION}
        </p>
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* One filter bar, driving both lists (rule 1b: server-side)        */}
      {/* ---------------------------------------------------------------- */}
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Find an item"
          value={search}
          onChange={setSearch}
          placeholder="Name or code"
          disabled={busy}
        />
        <Select
          label="Category"
          value={categoryId}
          onChange={setCategoryId}
          options={categoryOptions}
          disabled={busy}
        />
      </div>

      {/* ---------------------------------------------------------------- */}
      {/* THE WORKING LIST                                                 */}
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-2xl border border-sand-border bg-white/60">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-sand-border px-4 py-3">
          <h3 className="text-sm font-semibold text-charcoal">
            Still to count{' '}
            <span className="font-normal text-charcoal-muted">
              ({todo.count})
            </span>
          </h3>
          <CalculationNote note={COUNT_UNCOUNTED_EXPLANATION} />
        </div>

        {todo.error ? (
          <p className="px-4 py-6 text-center text-sm text-charcoal">
            We couldn’t load this count sheet: {todo.error.message}
          </p>
        ) : todo.loading && todo.rows.length === 0 ? (
          <div className="flex items-center justify-center py-12" aria-busy="true">
            <span className="sr-only">Loading the count sheet…</span>
            <span className="h-6 w-6 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
          </div>
        ) : todo.rows.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-charcoal-muted">
            {search || categoryId
              ? 'Nothing left to count in this filter.'
              : 'Every shelf on this sheet has been counted. Finish the count below.'}
          </p>
        ) : (
          <>
            <SheetTable rows={todo.rows} rowProps={rowProps} />
            <div className="px-4 pb-4">
              <Pagination
                page={todo.page}
                pageSize={todo.pageSize}
                totalCount={todo.count}
                onPageChange={todo.setPage}
                onPageSizeChange={todo.setPageSize}
                disabled={todo.loading || busy}
                itemNoun="shelves"
              />
            </div>
          </>
        )}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* THE ACCORDION — what has been counted, for fixing a wrong line   */}
      {/* ---------------------------------------------------------------- */}
      <section className="rounded-2xl border border-sand-border bg-white/60">
        <h3>
          <button
            type="button"
            onClick={() => setCountedOpen((v) => !v)}
            aria-expanded={countedOpen}
            className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left transition-colors hover:bg-sand/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          >
            <span className="text-sm font-semibold text-charcoal">
              Already counted{' '}
              <span className="font-normal text-charcoal-muted">
                ({done.count})
              </span>
            </span>
            <ChevronDownIcon
              className={`h-4 w-4 shrink-0 text-charcoal-muted transition-transform ${
                countedOpen ? 'rotate-180' : ''
              }`}
            />
          </button>
        </h3>

        {countedOpen ? (
          done.error ? (
            <p className="px-4 py-6 text-center text-sm text-charcoal">
              We couldn’t load these lines: {done.error.message}
            </p>
          ) : done.rows.length === 0 ? (
            <p className="border-t border-sand-border px-4 py-8 text-center text-sm text-charcoal-muted">
              Nothing counted yet. Numbers appear here as you key them.
            </p>
          ) : (
            <div className="border-t border-sand-border">
              <p className="px-4 pt-3 text-xs text-charcoal-muted">
                Change a number to correct it, or clear the field to put the
                shelf back to “not counted”.
              </p>
              <SheetTable rows={done.rows} rowProps={rowProps} />
              <div className="px-4 pb-4">
                <Pagination
                  page={done.page}
                  pageSize={done.pageSize}
                  totalCount={done.count}
                  onPageChange={done.setPage}
                  onPageSizeChange={done.setPageSize}
                  disabled={done.loading || busy}
                  itemNoun="shelves"
                />
              </div>
            </div>
          )
        ) : null}
      </section>

      {/* ---------------------------------------------------------------- */}
      {/* Finishing                                                        */}
      {/* ---------------------------------------------------------------- */}
      <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
        <h3 className="text-sm font-semibold text-charcoal">Finish this count</h3>
        <p className="mt-1 max-w-2xl text-xs text-charcoal-muted">
          Every difference between what you counted and what the system expected
          is recorded as a stock movement, dated{' '}
          {formatDisplayDate(take.business_date)}. Shelves you have not counted
          are left exactly as they are. The variance appears once the count is
          finished.
        </p>

        <div className="mt-3">
          <ManagerPinField
            value={pin}
            onChange={setPin}
            disabled={busy}
            title={COUNT_PIN_TITLE}
            lead={COUNT_PIN_LEAD}
            reason={COUNT_PIN_REASON}
          />
        </div>

        {finishError ? (
          <p className="mt-3 rounded-xl border border-accent/40 bg-accent/10 p-3 text-sm text-charcoal">
            {finishError}
          </p>
        ) : null}

        {movedWarning ? (
          <div className="mt-3">
            <FinishConfirmation
              message={movedWarning}
              busy={finishing}
              onConfirm={() => void handleFinish(true)}
              onCancel={() => setMovedWarning(null)}
            />
          </div>
        ) : null}

        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleFinish()}
            disabled={busy || movedWarning !== null}
            className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {finishing ? 'Finishing…' : 'Finish the count'}
          </button>
          <button
            type="button"
            onClick={() => setCancelOpen((v) => !v)}
            disabled={busy}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Abandon this count
          </button>
        </div>

        {cancelOpen ? (
          <div className="mt-3 rounded-xl border border-sand-border bg-sand/30 p-3">
            <p className="text-xs text-charcoal">
              An abandoned count posts nothing and changes no stock. What you
              counted stays on file, with your name against it — and the expected
              figures stay hidden, so abandoning a count is not a way to read
              them.
            </p>
            <div className="mt-2">
              <TextField
                label="Why is it being abandoned?"
                required
                value={cancelReason}
                onChange={setCancelReason}
                placeholder="e.g. Called away to a delivery"
                disabled={cancelling}
              />
            </div>
            {cancelError ? (
              <p className="mt-2 text-xs text-charcoal">{cancelError}</p>
            ) : null}
            <button
              type="button"
              onClick={() => void handleCancel()}
              disabled={cancelling}
              className="mt-2 rounded-full border border-accent/50 bg-white/70 px-4 py-2 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {cancelling ? 'Abandoning…' : 'Abandon it'}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

// THE ONE REFUSAL THAT ASKS A QUESTION (041).
//
// Extracted as a seam for the render proof (rule 22) and because it is the only
// place in this module where the server says "this is legal, but look at this
// first". Stock moved in the location while the count was running, and the
// shelves it moved on were counted AFTER it moved — so those counted figures
// probably already include the delivery, and posting the difference would
// record it twice.
//
// IT WRITES NONE OF THAT ITSELF. `message` is the server's sentence with its
// hint appended, rendered verbatim (rule 21) — including the item names, which
// only the server knows. A component that re-worded this would be a second
// source of truth about a rule that lives in one place, and it would drift the
// first time the rule changed, silently.
export function FinishConfirmation({
  message,
  busy,
  onConfirm,
  onCancel,
}: {
  message: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div
      className="rounded-xl border-2 border-accent/50 bg-accent/10 p-3 sm:p-4"
      role="alert"
    >
      <p className="text-sm font-bold text-charcoal">
        Check these shelves before finishing
      </p>
      <p className="mt-1.5 text-sm text-charcoal">{message}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* GOING BACK IS THE FIRST OPTION and the visually plain one: the usual
            right answer is to re-count the named shelves, not to push through.
            Confirming is offered second and says exactly what it will do. */}
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-full border border-sand-border bg-white/80 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Go back and check
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={busy}
          className="rounded-full border border-accent bg-white/80 px-5 py-2.5 text-sm font-semibold text-accent transition-colors hover:bg-accent/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? 'Finishing…' : 'Finish anyway'}
        </button>
      </div>
    </div>
  );
}

// The table both sections render. One markup, so the working list and the
// accordion can never drift into looking like different things.
function SheetTable({
  rows,
  rowProps,
}: {
  rows: StockTakeSheetRow[];
  rowProps: (row: StockTakeSheetRow) => Parameters<typeof CountSheetRow>[0];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm sm:min-w-[32rem]">
        <thead>
          <tr className="border-b border-sand-border bg-sand/40 text-left">
            <th scope="col" className="px-3 py-2 text-xs font-semibold text-charcoal-muted sm:px-4">
              Item
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
              Counted
            </th>
            <th scope="col" className="px-2 py-2 text-right text-xs font-semibold text-charcoal-muted">
              Status
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-sand-border/50">
          {rows.map((row) => (
            <CountSheetRow key={row.line_id} {...rowProps(row)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ONE COUNT LINE, extracted so it can be RENDERED in a proof without standing up
// the whole sheet and its data fetch — the same seam StockItemLedger's LedgerRow
// provides, and for rule 22's reason: a SQL proof cannot render React, and the
// two things this row can get wrong are both shapes rather than queries.
//
// THE TWO NULLS IT MUST TELL APART (and the proof makes it fail on each):
//   * counted_quantity === null  -> NOT COUNTED. Must never render as "0", or a
//     shelf nobody visited reads as a shelf that was found empty.
//   * a counted ZERO             -> COUNTED, AND EMPTY. Must never render as
//     blank, or the most important answer on the sheet disappears.
// And it must not render an expected quantity at all — there is none in the row.
export function CountSheetRow({
  row,
  draft,
  state,
  message,
  disabled,
  onDraftChange,
  onCommit,
}: {
  row: StockTakeSheetRow;
  // What is currently in the field, when the counter is mid-edit. `undefined`
  // means "not being edited", and the saved value is shown instead.
  draft: string | undefined;
  state: LineState;
  message: string | null;
  disabled: boolean;
  onDraftChange: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  // §6: the column arrives as a STRING. The field shows the saved value, and a
  // saved ZERO must survive this — `|| ''` would turn it into an empty field and
  // silently un-count the shelf, which is exactly the class of bug rule 22 was
  // written about.
  const saved = row.counted_quantity === null ? '' : row.counted_quantity;
  const value = draft !== undefined ? draft : saved;

  return (
    <tr>
      <td className="px-3 py-2.5 align-top sm:px-4">
        <span className="block font-medium text-charcoal">{row.item_name}</span>
        <span className="mt-0.5 block text-xs text-charcoal-muted">
          {row.item_code ? `${row.item_code} · ` : ''}in {row.base_unit}
        </span>
        {message ? (
          <span className="mt-1 block text-xs font-medium text-accent">
            {message}
          </span>
        ) : null}
      </td>
      <td className="px-2 py-2.5 text-right align-top">
        <input
          type="number"
          inputMode="decimal"
          step="any"
          min={0}
          value={value}
          disabled={disabled || state === 'saving'}
          onChange={(e) => onDraftChange(e.target.value)}
          onBlur={(e) => onCommit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onCommit((e.target as HTMLInputElement).value);
            }
          }}
          aria-label={`Counted quantity for ${row.item_name}`}
          className="w-24 rounded-lg border border-sand-border bg-white/70 px-2 py-1.5 text-right text-sm tabular-nums text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        />
      </td>
      <td className="px-2 py-2.5 text-right align-top text-xs">
        {state === 'saving' ? (
          <span className="text-charcoal-muted">Saving…</span>
        ) : state === 'error' ? (
          <span className="font-semibold text-accent">Not saved</span>
        ) : row.is_counted ? (
          <span className="font-semibold text-primary">
            Counted {formatQuantity(row.counted_quantity)} {row.base_unit}
          </span>
        ) : (
          // NOT a dash and NOT a zero: a shelf nobody has been to says so in
          // words, because both of the obvious alternatives read as a quantity.
          <span className="text-charcoal-muted">Not counted</span>
        )}
      </td>
    </tr>
  );
}
