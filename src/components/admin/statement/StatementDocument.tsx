import {
  formatMoney,
  formatRatePercent,
  MISSING_VALUE,
} from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { formatNights } from '../../../lib/bookingLabels';
import type {
  StatementData,
  StatementGroup,
  StatementLine,
} from '../../../lib/statement';

// ===========================================================================
// THE GUEST-FACING STATEMENT — RENDERING ONLY.
// ===========================================================================
//
// This component receives a StatementData (lib/statement) and prints it. It
// FETCHES NOTHING, COMPUTES NOTHING and DECIDES NOTHING: no query, no
// arithmetic, no filtering, not even the room/extras split — all of that is the
// assembly's, so the coming PDF / Excel / Word exporters consume exactly what
// this screen shows. If you find yourself needing a value here that
// StatementData does not carry, add it to the assembly; an exporter cannot
// reuse a value the renderer worked out for itself.
//
// ---------------------------------------------------------------------------
// WHAT THIS DOCUMENT IS, AND WHAT IT IS NOT
// ---------------------------------------------------------------------------
// It is the bill the desk hands or sends to the guest for ONE stay (or one
// non-resident account). It is ONE ADAPTIVE DOCUMENT — headed "Statement", with
// the outstanding balance made prominent when there is one, so it doubles as
// the invoice without the system having to decide in advance whether it is
// issuing an invoice or a receipt.
//
// It is NOT the internal folio bill (FolioBill), which carries the void trail,
// the discount approvals, the posting dates and the per-line ⋯ tools. There is
// deliberately NO action of any kind on this page: no void, no discount, no
// kebab, not one control inside the document. A staff tool rendered onto a
// guest's bill is a tool a guest can be handed.
//
// It is NOT the guest ledger either — that is the whole account across every
// stay. This is one folio, itemised.
//
// VOIDED LINES ARE ABSENT (the assembly drops them) and the totals still
// reconcile: folio_totals excludes voided rows and a voided charge produces no
// tax lines, so what is printed sums to what is printed. The reasoning is
// written out in lib/statement's header.
//
// ---------------------------------------------------------------------------
// PRINT
// ---------------------------------------------------------------------------
// The on-screen version and the printed version are the SAME component — print
// CSS only hides the chrome around it (the admin sidebar, header and the print
// bar are all print:hidden already). There is no second renderer, so there is
// nothing that can disagree with the screen.
//
// It is designed to be READABLE IN BLACK AND WHITE: the balance's state is
// carried by its WORD ("Amount due" / "Paid in full" / "Credit — refund due")
// and by weight and rules, with colour only reinforcing it. A guest reading a
// fax-grey photocopy must still see what they owe. `statement-sheet` (index.css)
// carries the A4 page setup.

interface StatementDocumentProps {
  statement: StatementData;
}

export function StatementDocument({ statement }: StatementDocumentProps) {
  const { property, totals } = statement;
  const currency = property.currency;
  const hasLines = statement.groups.length > 0 || statement.payments.length > 0;

  return (
    <article
      className="statement-sheet mx-auto max-w-3xl rounded-2xl border border-sand-border bg-white p-5 text-charcoal sm:p-8 print:max-w-none print:rounded-none print:border-0 print:p-0"
      aria-label={`${statement.title} ${statement.reference}`}
    >
      <Letterhead statement={statement} />

      <PartyBlock statement={statement} />

      {/* ---- The itemised charges -------------------------------------- */}
      {/* NO horizontal scroll at any width (the pattern the folio bill and the
          ledger already use): below `sm` the SN and Date columns fold into the
          description cell and only Description + Amount remain as columns, so
          the bill reads top-to-bottom on the phone a guest is shown it on. */}
      <table className="mt-6 w-full border-collapse text-sm">
        <caption className="sr-only">
          Charges and payments on this {statement.kind === 'stay' ? 'stay' : 'account'}
        </caption>
        <thead>
          <tr className="border-y border-charcoal/20 text-left">
            <th
              scope="col"
              className="hidden py-2 pr-2 text-xs font-semibold uppercase tracking-wide text-charcoal-muted sm:table-cell sm:w-10"
            >
              SN
            </th>
            <th
              scope="col"
              className="hidden py-2 pr-2 text-xs font-semibold uppercase tracking-wide text-charcoal-muted sm:table-cell sm:w-[6.5rem]"
            >
              Date
            </th>
            <th
              scope="col"
              className="hidden py-2 pr-2 text-xs font-semibold uppercase tracking-wide text-charcoal-muted sm:table-cell sm:w-[8.5rem]"
            >
              Type
            </th>
            <th
              scope="col"
              className="py-2 pr-2 text-xs font-semibold uppercase tracking-wide text-charcoal-muted"
            >
              Description
            </th>
            <th
              scope="col"
              className="py-2 pl-2 text-right text-xs font-semibold uppercase tracking-wide text-charcoal-muted"
            >
              Amount
            </th>
          </tr>
        </thead>

        {!hasLines ? (
          <tbody>
            <tr>
              <td colSpan={5} className="py-10 text-center text-sm text-charcoal-muted">
                Nothing has been charged to this{' '}
                {statement.kind === 'stay' ? 'stay' : 'account'} yet.
              </td>
            </tr>
          </tbody>
        ) : null}

        {/* Grouped room / extras, with ONE continuous SN sequence across the
            groups — the headings separate, they do not restart the numbering
            and they carry no subtotal of their own (see the assembly). */}
        {statement.groups.map((group) => (
          <ChargeGroup key={group.key} group={group} currency={currency} />
        ))}

        {/* ---- Subtotal, each tax once, total charges -------------------
            Rendered whenever the folio has ANY line, charges or payments — not
            only when something has been charged. A PRE-ARRIVAL DEPOSIT is a
            folio with payments and no charges yet (021 §9.4: a deposit is
            simply a payment on the open folio), and its statement is the
            deposit receipt the guest is given. Showing "Total charges ₦0.00"
            above "Payments received" is what makes that page add up to the
            credit at its foot; hiding the line would leave a payment appearing
            from nowhere. */}
        {hasLines ? (
          <tbody>
            {/* Shown only when something was actually given away: a "− ₦0.00"
                line on an ordinary bill is a question with no answer. */}
            {totals.discount > 0 ? (
              <>
                <FigureRow
                  label="Charges before discount"
                  amount={totals.gross}
                  currency={currency}
                  muted
                />
                <FigureRow
                  label="Discount"
                  amount={totals.discount}
                  currency={currency}
                  muted
                  signed="minus"
                />
              </>
            ) : null}
            <FigureRow label="Subtotal" amount={totals.subtotal} currency={currency} />
            {totals.taxes.map((tax) => (
              <FigureRow
                key={tax.code}
                label={`${tax.name} (${formatRatePercent(tax.rate)})`}
                amount={tax.amount}
                currency={currency}
                muted
              />
            ))}
            <FigureRow
              label="Total charges"
              amount={totals.charges}
              currency={currency}
              strong
            />
          </tbody>
        ) : null}

        {/* ---- Payments, in their own section, never interleaved -------- */}
        {statement.payments.length > 0 ? (
          <tbody>
            <SectionHeading label="Payments received" />
            {statement.payments.map((line) => (
              <LineRow key={line.key} line={line} currency={currency} />
            ))}
            <FigureRow
              label="Payments received"
              amount={totals.payments}
              currency={currency}
              signed="minus"
            />
          </tbody>
        ) : null}
      </table>

      <BalanceBlock statement={statement} />

      <Footer statement={statement} />
    </article>
  );
}

// ---------------------------------------------------------------------------
// The letterhead
// ---------------------------------------------------------------------------
// The property's own identity, entirely from its record (rule 17): its name, its
// logo asset, its address, phone and email — never a literal, and never the
// tenant name, because a guest was a guest of a PROPERTY.
//
// The logo is rendered when one resolves and the NAME is the fallback wordmark
// otherwise, so an unconfigured property still prints a document that identifies
// itself and a dangling asset id never becomes a broken image. alt="" because
// the name is printed beside it either way — a screen reader that announced the
// logo would read the hotel's name twice.
function Letterhead({ statement }: { statement: StatementData }) {
  const { property } = statement;

  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-charcoal/20 pb-5">
      <div className="min-w-0">
        {property.logoUrl ? (
          <img
            src={property.logoUrl}
            alt=""
            className="mb-2 h-14 w-auto max-w-[220px] object-contain object-left"
          />
        ) : null}
        <p className="text-lg font-bold tracking-tight text-charcoal">
          {property.name}
        </p>
        {property.address ? (
          <p className="mt-0.5 text-xs leading-relaxed text-charcoal-muted">
            {property.address}
          </p>
        ) : null}
        {property.phone || property.email ? (
          <p className="text-xs leading-relaxed text-charcoal-muted">
            {[property.phone, property.email].filter(Boolean).join(' · ')}
          </p>
        ) : null}
      </div>

      <div className="text-right">
        <h1 className="text-xl font-bold uppercase tracking-[0.2em] text-charcoal">
          {statement.title}
        </h1>
        <p className="mt-1 text-xs text-charcoal-muted">
          {statement.referenceLabel}{' '}
          <span className="font-semibold tabular-nums text-charcoal">
            {statement.reference}
          </span>
        </p>
        <p className="text-xs text-charcoal-muted">
          Issued{' '}
          <span className="tabular-nums text-charcoal">
            {formatDisplayDate(statement.issueDate)}
          </span>
        </p>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Who this is for, and what it is for
// ---------------------------------------------------------------------------
// Two columns on paper and on a wide screen, stacked on a phone. The stay column
// is simply absent on a standalone statement — there is no room, no dates and no
// nights to describe, and a block of dashes would suggest data went missing.
function PartyBlock({ statement }: { statement: StatementData }) {
  const { guest, billTo, stay } = statement;

  return (
    <section className="mt-5 grid gap-5 sm:grid-cols-2">
      <div className="min-w-0">
        <h2 className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
          {billTo ? 'Guest' : 'Billed to'}
        </h2>
        <p className="mt-1 font-semibold text-charcoal">{guest.name}</p>
        {guest.phone || guest.email ? (
          <p className="text-xs leading-relaxed text-charcoal-muted">
            {[guest.phone, guest.email].filter(Boolean).join(' · ')}
          </p>
        ) : null}
        {/* A corporate stay is billed to the company: the guest slept in the
            room, the company owes the money, and the document must not blur
            the two. */}
        {billTo ? (
          <>
            <h2 className="mt-3 text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
              Billed to
            </h2>
            <p className="mt-1 font-semibold text-charcoal">{billTo.name}</p>
          </>
        ) : null}
      </div>

      {stay ? (
        <div className="min-w-0 sm:text-right">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
            Stay
          </h2>
          <p className="mt-1 font-semibold text-charcoal">
            {stay.roomTypeName ?? MISSING_VALUE}
          </p>
          <p className="text-xs leading-relaxed tabular-nums text-charcoal-muted">
            {/* The BILLED window: from the recorded arrival once checked in.
                The label says which, so a stay whose guest arrived a day late
                does not read as a hotel quietly changing the dates. */}
            {stay.arrived ? 'Arrived' : 'Arriving'}{' '}
            {formatDisplayDate(stay.checkIn)} · Departing{' '}
            {formatDisplayDate(stay.checkOut)}
          </p>
          <p className="text-xs leading-relaxed tabular-nums text-charcoal-muted">
            {formatNights(stay.nights)}
            {stay.reservedNights !== null
              ? ` (${stay.reservedNights} reserved)`
              : ''}
          </p>
        </div>
      ) : (
        <div className="min-w-0 sm:text-right">
          <h2 className="text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted">
            Account
          </h2>
          {/* A non-resident tab: charges and payments that belong to the guest
              but to no stay (028 §2). Saying so is the whole adaptation — the
              reader must not wonder which room this was. */}
          <p className="mt-1 text-xs leading-relaxed text-charcoal-muted">
            Charges not tied to a stay
          </p>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function ChargeGroup({
  group,
  currency,
}: {
  group: StatementGroup;
  currency: string;
}) {
  return (
    <tbody>
      <SectionHeading label={group.label} />
      {group.lines.map((line) => (
        <LineRow key={line.key} line={line} currency={currency} />
      ))}
    </tbody>
  );
}

function SectionHeading({ label }: { label: string }) {
  return (
    <tr>
      <th
        scope="colgroup"
        colSpan={5}
        className="border-b border-charcoal/10 pt-4 pb-1 text-left text-[11px] font-semibold uppercase tracking-wide text-charcoal-muted"
      >
        {label}
      </th>
    </tr>
  );
}

// One printed line. Same five columns as the internal bill minus its action
// column — that column, and everything behind it, is exactly what a guest must
// not be handed.
function LineRow({ line, currency }: { line: StatementLine; currency: string }) {
  const dateText = formatDisplayDate(line.date);
  // The assembly leaves an absent description EMPTY so an exported cell is
  // empty; a screen shows the shared dash instead of a silent gap (§6).
  const description = line.description || MISSING_VALUE;

  return (
    <tr className="align-top">
      <td className="hidden py-2 pr-2 text-xs tabular-nums text-charcoal-muted sm:table-cell">
        {line.sn}
      </td>
      <td className="hidden whitespace-nowrap py-2 pr-2 text-sm tabular-nums text-charcoal-muted sm:table-cell">
        {dateText}
      </td>
      <td className="hidden py-2 pr-2 text-sm text-charcoal sm:table-cell">
        {line.type || MISSING_VALUE}
      </td>
      <td className="py-2 pr-2 text-sm">
        {/* THE MOBILE FOLD: type above, date below — the same facts, moved, and
            nothing dropped or scrolled sideways. */}
        <span className="mb-0.5 block text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted sm:hidden">
          {line.type || MISSING_VALUE}
        </span>
        <span className="block text-charcoal">{description}</span>
        <span className="block text-[11px] tabular-nums text-charcoal-muted sm:hidden">
          {dateText}
        </span>
      </td>
      <td className="whitespace-nowrap py-2 pl-2 text-right text-sm tabular-nums text-charcoal">
        {formatMoney(line.amount, currency)}
      </td>
    </tr>
  );
}

// A figure line: a label and an amount, aligned in the same column as the lines
// above it. The three spacer cells (rather than a colSpan) keep the amount in
// its own column on mobile, where those three columns do not exist.
function FigureRow({
  label,
  amount,
  currency,
  muted = false,
  strong = false,
  signed,
}: {
  label: string;
  amount: number;
  currency: string;
  muted?: boolean;
  strong?: boolean;
  // Discounts and payments REDUCE what is owed; a leading minus makes the
  // column read as the subtraction it is.
  signed?: 'minus';
}) {
  const text =
    signed === 'minus' && amount !== 0
      ? `−${formatMoney(Math.abs(amount), currency)}`
      : formatMoney(amount, currency);

  return (
    <tr>
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
      <td className="hidden sm:table-cell" />
      <th
        scope="row"
        className={`py-1.5 pr-2 text-left text-sm ${
          strong
            ? 'border-t border-charcoal/20 pt-2 font-semibold text-charcoal'
            : muted
              ? 'font-normal text-charcoal-muted'
              : 'font-medium text-charcoal'
        }`}
      >
        {label}
      </th>
      <td
        className={`whitespace-nowrap py-1.5 pl-2 text-right text-sm tabular-nums ${
          strong
            ? 'border-t border-charcoal/20 pt-2 font-semibold text-charcoal'
            : muted
              ? 'text-charcoal-muted'
              : 'text-charcoal'
        }`}
      >
        {text}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// THE BALANCE — the one thing on the page that must be unmissable
// ---------------------------------------------------------------------------
// This is what makes ONE document serve as both invoice and receipt: when money
// is owed it reads as an amount due and the page is an invoice; when it is
// settled it says so and the page is a receipt; when the hotel is holding the
// guest's money it says a refund is due.
//
// THE WORD CARRIES THE MEANING, not the colour — the document has to survive a
// black-and-white photocopy and a monochrome laser printer. Colour follows the
// same rule the folio, the ledger and the bookings list already use, so no two
// screens disagree about what red means:
//   > 0   text-negative — the guest owes.
//   <= 0  text-positive — nothing owed (settled, or in credit).
// Both are theme tokens (rule 17), contrast-proven at their definition.
//
// THE MAGNITUDE IS PRINTED, and the word says the direction. "− ₦20,000.00"
// beside "Credit" would ask a guest to interpret a minus sign against a word
// that already means the same thing, and a stray minus on a bill reads as an
// error.
function BalanceBlock({ statement }: { statement: StatementData }) {
  const { amount, state } = statement.balance;
  const currency = statement.property.currency;

  // "Credit / refund due" covers both readings on purpose, because the folio
  // cannot tell them apart and must not pretend to: a negative balance is a
  // pre-arrival deposit before any charges post (021 §9.4 — a deposit IS a
  // payment on the open folio), and it is money to hand back once the stay is
  // over. Same figure, and which one it is depends on where the stay has got
  // to, which the desk knows and the document should not guess.
  const label =
    state === 'due'
      ? 'Amount due'
      : state === 'credit'
        ? 'Credit / refund due'
        : 'Paid in full';

  return (
    <section
      aria-label="Outstanding balance"
      className={`mt-5 flex flex-wrap items-baseline justify-between gap-3 border-2 px-4 py-3 ${
        state === 'due' ? 'border-negative' : 'border-charcoal/30'
      }`}
    >
      <p className="text-sm font-bold uppercase tracking-wide text-charcoal">
        {label}
      </p>
      <p
        className={`text-xl font-bold tabular-nums ${
          state === 'due' ? 'text-negative' : 'text-positive'
        }`}
      >
        {formatMoney(Math.abs(amount), currency)}
      </p>
    </section>
  );
}

// The closing block: the property's own thank-you line (or a neutral default)
// and its configured note — payment terms, bank details — rendered only when
// set, so an unconfigured property prints a clean page rather than an empty
// slot. Both come from property settings, never from a literal here (rule 17).
function Footer({ statement }: { statement: StatementData }) {
  const { thankYou, note } = statement.footer;

  return (
    <footer className="mt-6 border-t border-charcoal/20 pt-4">
      <p className="text-sm text-charcoal">{thankYou}</p>
      {note ? (
        <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-charcoal-muted">
          {note}
        </p>
      ) : null}
    </footer>
  );
}
