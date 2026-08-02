import { formatMoney, formatRatePercent, MISSING_VALUE } from '../format';
import { formatDisplayDate } from '../date';
import { formatNights } from '../bookingLabels';
import type { StatementBalanceState, StatementData } from '../statement';

// ===========================================================================
// THE STATEMENT, FLATTENED ONCE FOR EVERY EXPORTER.
// ===========================================================================
//
// assembleStatement (lib/statement) is the source of truth for WHAT the document
// says. This file is the source of truth for HOW IT READS: the order of the
// blocks, the label beside each figure, and the exact string each amount and
// date is printed as.
//
// It exists because four exporters (PDF, Excel, Word, WhatsApp) plus the screen
// would otherwise each decide for themselves that the discount line is called
// "Discount", that a payment prints with a leading minus, and that a tax line
// carries its rate in brackets. Four such decisions are four chances to drift,
// and the day two of them disagreed nothing would error — a guest would simply
// hold a PDF that says something different from the screen the desk is reading.
//
// SO: NOTHING HERE COMPUTES A FIGURE. Every number is copied out of
// StatementData (which is folio_totals' and the folio engine's), and the only
// transformation applied is a SIGN FLIP on the two lines that subtract — the
// discount and the payments total — because that is what the screen prints. The
// formatting goes through lib/format's own helpers, the same calls the screen
// makes, so a figure cannot be formatted one way on paper and another on glass.
//
// The screen (StatementDocument) shares this file's balance label and amount
// formatter for exactly that reason. It keeps its own table markup — it has a
// mobile fold and a print stylesheet an exporter has no use for — but the WORDS
// and the FIGURES come from here.

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

// The statement's own amount formatter: money in the property's currency, with a
// NEGATIVE printed as a real minus sign (U+2212) ahead of the magnitude, which
// is what the document's figure rows do. Intl's own negative form uses an ASCII
// hyphen and sometimes parenthesises, and a bill that renders "-₦20,000.00" in
// one channel and "−₦20,000.00" in another invites a reader to wonder which is
// the real one.
//
// `amount || 0` normalises -0 (which Intl would print as "-₦0.00") to a plain
// zero — a discount line of exactly nothing must not acquire a minus sign.
export function formatStatementAmount(amount: number, currency: string): string {
  if (amount < 0) return `−${formatMoney(Math.abs(amount), currency)}`;
  return formatMoney(amount || 0, currency);
}

// THE BALANCE'S WORD — the one thing on the document that must survive a
// black-and-white photocopy, so the state is said in words and colour only
// reinforces it. Shared with the screen so the PDF, the spreadsheet, the Word
// file, the WhatsApp summary and the page all use the same three phrases.
//
// "Credit / refund due" covers both readings deliberately: a negative balance is
// a pre-arrival deposit before any charge has posted AND money to hand back once
// the stay is over. The folio cannot tell those apart and must not pretend to.
export function statementBalanceLabel(state: StatementBalanceState): string {
  if (state === 'due') return 'Amount due';
  if (state === 'credit') return 'Credit / refund due';
  return 'Paid in full';
}

// ---------------------------------------------------------------------------
// The header facts
// ---------------------------------------------------------------------------

export interface StatementFact {
  // Which block the fact belongs to: 'document' is the document's own handle
  // (what it is and when it was issued), which the screen prints in the
  // letterhead; 'party' is who and what it is for, which the screen prints
  // beneath it. A format with one column (a spreadsheet) renders them in one
  // run; a laid-out page (the PDF) puts each where the screen puts it.
  group: 'document' | 'party';
  label: string;
  value: string;
}

// Everything the letterhead and party block state, as label/value pairs — the
// same facts, in the same order, and worded exactly as StatementDocument's
// PartyBlock words them. A spreadsheet renders them as two columns, Word as
// paragraphs, the PDF as two blocks; none of them decides what the facts are.
export function statementFacts(statement: StatementData): StatementFact[] {
  const { guest, billTo, stay } = statement;
  const facts: StatementFact[] = [
    {
      group: 'document',
      label: statement.referenceLabel,
      value: statement.reference,
    },
    {
      group: 'document',
      label: 'Issued',
      value: formatDisplayDate(statement.issueDate),
    },
    // A corporate stay names the guest AND the company, and the heading over the
    // guest changes when it does — the guest slept in the room, the company owes
    // the money, and the document must not blur the two.
    { group: 'party', label: billTo ? 'Guest' : 'Billed to', value: guest.name },
  ];

  const contact = [guest.phone, guest.email].filter(Boolean).join(' · ');
  if (contact) facts.push({ group: 'party', label: 'Contact', value: contact });
  if (billTo) {
    facts.push({ group: 'party', label: 'Billed to', value: billTo.name });
  }

  if (stay) {
    facts.push({
      group: 'party',
      label: 'Room',
      value: stay.roomTypeName ?? MISSING_VALUE,
    });
    facts.push({
      group: 'party',
      label: 'Stay',
      // The BILLED window, labelled so a stay whose guest arrived a day late
      // does not read as a hotel quietly changing the dates.
      value: `${stay.arrived ? 'Arrived' : 'Arriving'} ${formatDisplayDate(
        stay.checkIn,
      )} · Departing ${formatDisplayDate(stay.checkOut)}`,
    });
    facts.push({
      group: 'party',
      label: 'Nights',
      value: `${formatNights(stay.nights)}${
        stay.reservedNights !== null ? ` (${stay.reservedNights} reserved)` : ''
      }`,
    });
  } else {
    // A non-resident tab has no room and no dates. Saying so is the whole
    // adaptation — the reader must not be left wondering which room this was.
    facts.push({
      group: 'party',
      label: 'Account',
      value: 'Charges not tied to a stay',
    });
  }

  return facts;
}

// ---------------------------------------------------------------------------
// The body: sections, lines and figures, in printed order
// ---------------------------------------------------------------------------

export type StatementRow =
  // A group heading: "Room", "Extras", "Charges", "Payments received".
  | { kind: 'section'; label: string }
  // One charge or payment line, exactly as the assembly built it.
  | {
      kind: 'line';
      sn: number;
      // Formatted through the screen's own date helper (rules 8, 12: this is the
      // BUSINESS date the assembly carries, never created_at).
      date: string;
      type: string;
      description: string;
      // The machine value, for a spreadsheet cell that must be summable.
      amount: number;
      amountText: string;
    }
  // A total, a tax, a discount — a label and one figure.
  | {
      kind: 'figure';
      label: string;
      // SIGNED AS PRINTED: the discount and the payments total are carried
      // negative here because that is how the document shows them (they reduce
      // what is owed). A spreadsheet can therefore sum this column straight down
      // and land on the balance, which is the whole reason the machine value
      // travels beside the text.
      amount: number;
      amountText: string;
      weight: 'muted' | 'normal' | 'strong';
    };

// The printed body in order. Transcribes StatementDocument's own sequence:
// grouped charges → (discount working) → subtotal → each tax once → total
// charges → payments → payments received.
//
// IF YOU CHANGE THE ORDER ON THE SCREEN, CHANGE IT HERE. The two are kept in
// step by hand precisely because the exports must not quietly diverge; there is
// a matching note in StatementDocument.
export function statementRows(statement: StatementData): StatementRow[] {
  const currency = statement.property.currency;
  const { totals } = statement;
  const rows: StatementRow[] = [];

  const line = (l: {
    sn: number;
    date: string;
    type: string;
    description: string;
    amount: number;
  }): StatementRow => ({
    kind: 'line',
    sn: l.sn,
    date: formatDisplayDate(l.date),
    type: l.type,
    description: l.description,
    amount: l.amount,
    // formatMoney, not formatStatementAmount — a refund line is a negative
    // payment and the screen prints it through formatMoney too. Same call, same
    // string.
    amountText: formatMoney(l.amount, currency),
  });

  const figure = (
    label: string,
    amount: number,
    weight: 'muted' | 'normal' | 'strong' = 'normal',
  ): StatementRow => ({
    kind: 'figure',
    label,
    amount,
    amountText: formatStatementAmount(amount, currency),
    weight,
  });

  for (const group of statement.groups) {
    rows.push({ kind: 'section', label: group.label });
    for (const l of group.lines) rows.push(line(l));
  }

  // Rendered whenever the folio has ANY line, charges or payments — a
  // pre-arrival deposit is a folio with payments and no charges, and its
  // statement is the deposit receipt. "Total charges ₦0.00" above the payment is
  // what makes that page add up.
  const hasLines = statement.groups.length > 0 || statement.payments.length > 0;
  if (hasLines) {
    // Shown only when something was actually given away: a "− ₦0.00" line on an
    // ordinary bill is a question with no answer.
    if (totals.discount > 0) {
      rows.push(figure('Charges before discount', totals.gross, 'muted'));
      rows.push(figure('Discount', -totals.discount, 'muted'));
    }
    rows.push(figure('Subtotal', totals.subtotal));
    for (const tax of totals.taxes) {
      rows.push(
        figure(`${tax.name} (${formatRatePercent(tax.rate)})`, tax.amount, 'muted'),
      );
    }
    rows.push(figure('Total charges', totals.charges, 'strong'));
  }

  if (statement.payments.length > 0) {
    rows.push({ kind: 'section', label: 'Payments received' });
    for (const l of statement.payments) rows.push(line(l));
    rows.push(figure('Payments received', -totals.payments));
  }

  return rows;
}

// The five columns every tabular rendering of the body uses, named once.
export const STATEMENT_COLUMNS = ['SN', 'Date', 'Type', 'Description', 'Amount'];

// What the document says when there is nothing on the folio at all. The screen
// prints this in place of the table; so does every export, rather than shipping
// an empty grid that reads like a failed load.
export function statementEmptyMessage(statement: StatementData): string {
  return `Nothing has been charged to this ${
    statement.kind === 'stay' ? 'stay' : 'account'
  } yet.`;
}
