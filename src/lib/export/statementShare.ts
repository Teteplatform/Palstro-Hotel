import type { StatementData } from '../statement';
import { formatMoney } from '../format';
import { formatDisplayDate } from '../date';
import { formatNights } from '../bookingLabels';
import { statementBalanceLabel } from './statementSections';

// ===========================================================================
// SENDING THE STATEMENT ON WHATSAPP.
// ===========================================================================
//
// WhatsApp is how a Nigerian front desk actually reaches a guest, so this is the
// share that matters most on a phone. Two mechanisms, and the better one is used
// wherever the browser has it:
//
//   1. THE NATIVE SHARE SHEET WITH THE PDF ATTACHED (navigator.share with a
//      File). On Android Chrome and iOS Safari this puts the actual document in
//      the guest's chat — one tap, a real attachment, nothing retyped. This is
//      the path a desk wants, which is why it is tried first.
//
//   2. A wa.me LINK carrying a short pre-filled summary. Every desktop browser
//      lands here (no browser on a laptop can share a file to WhatsApp), and so
//      does any phone that refuses the share sheet. The message opens ready to
//      send; the desk attaches the downloaded PDF themselves if they want the
//      full document to go with it.
//
// THE SUMMARY SAYS THE SAME THING THE DOCUMENT SAYS. Every figure in it is read
// off the SAME assembled statement, through the same lib/format helpers the
// screen uses — a WhatsApp message quoting a different amount due from the PDF
// attached beneath it is precisely the failure this build exists to prevent.
//
// AND IT IS HONEST ABOUT WHAT WAS SENT: the closing line says the statement is
// attached only when a file actually went with it.

export interface ShareTextOptions {
  // True only when the PDF is genuinely travelling with this message.
  attached: boolean;
}

// A guest reads a summary, not a bill. Four facts and the figure they care
// about: who it is from, which document, which stay, and what is outstanding.
export function statementShareText(
  statement: StatementData,
  options: ShareTextOptions,
): string {
  const currency = statement.property.currency;
  const { stay, totals, balance } = statement;

  const lines: string[] = [
    `*${statement.property.name}*`,
    `${statement.title} ${statement.reference} · ${formatDisplayDate(
      statement.issueDate,
    )}`,
    '',
    statement.guest.name,
  ];

  if (stay) {
    lines.push(
      `${stay.arrived ? 'Arrived' : 'Arriving'} ${formatDisplayDate(
        stay.checkIn,
      )} · Departing ${formatDisplayDate(stay.checkOut)} (${formatNights(
        stay.nights,
      )})`,
    );
  }

  lines.push('');
  lines.push(`Total charges: ${formatMoney(totals.charges, currency)}`);
  if (totals.payments !== 0) {
    lines.push(`Payments received: ${formatMoney(totals.payments, currency)}`);
  }
  // The magnitude beside the state's own word, as every other channel prints it.
  lines.push(
    `*${statementBalanceLabel(balance.state)}: ${formatMoney(
      Math.abs(balance.amount),
      currency,
    )}*`,
  );

  lines.push('');
  lines.push(
    options.attached
      ? 'Your full statement is attached.'
      : 'Your full statement is available on request.',
  );

  return lines.join('\n');
}

// wa.me, with the recipient only when their number is unambiguous.
//
// A NUMBER IS ONLY USED IF IT IS ALREADY INTERNATIONAL. Nigerian numbers are
// commonly stored in local form ("08031234567"), and wa.me takes digits with a
// country code and no plus. Stripping the leading zero and guessing 234 would
// send a guest's bill to whichever stranger owns that number in whatever country
// the guess landed in — a real, unrecoverable privacy breach for a saving of one
// tap. So a local number opens WhatsApp with the message ready and NO recipient,
// and the desk picks the chat.
export function whatsappShareUrl(text: string, phone: string | null): string {
  const recipient = internationalDigits(phone);
  const query = `?text=${encodeURIComponent(text)}`;
  return recipient ? `https://wa.me/${recipient}${query}` : `https://wa.me/${query}`;
}

function internationalDigits(phone: string | null): string | null {
  if (!phone) return null;
  const trimmed = phone.trim();
  const isInternational = trimmed.startsWith('+') || trimmed.startsWith('00');
  if (!isInternational) return null;
  const digits = trimmed.replace(/\D/g, '').replace(/^00/, '');
  // Shortest plausible international number is a country code plus a subscriber
  // number; anything under 8 digits is a typo, not a phone number.
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// Can this browser share a FILE (not just a link)? Probed with a throwaway File
// rather than by sniffing the user agent, and probed SYNCHRONOUSLY at click time
// so the answer is known before any await — the fallback needs the user's
// gesture still in hand to open a window.
export function canShareStatementFile(): boolean {
  if (typeof navigator === 'undefined' || !navigator.canShare || !navigator.share) {
    return false;
  }
  try {
    const probe = new File([new Uint8Array(1)], 'probe.pdf', {
      type: 'application/pdf',
    });
    return navigator.canShare({ files: [probe] });
  } catch {
    return false;
  }
}

export type ShareOutcome = 'shared' | 'cancelled' | 'unsupported';

// Hand the file to the platform's share sheet.
//
// A CANCELLED SHARE IS NOT AN ERROR — closing the sheet is a decision, and
// surfacing it as a failed export would be nonsense. NotAllowedError means the
// browser no longer considers this a user gesture (iOS Safari is strict about
// awaits before the call), which is a genuine 'unsupported' and sends the caller
// to the wa.me fallback.
export async function shareStatementFile(
  file: File,
  title: string,
  text: string,
): Promise<ShareOutcome> {
  if (!navigator.canShare?.({ files: [file] })) return 'unsupported';
  try {
    await navigator.share({ files: [file], title, text });
    return 'shared';
  } catch (e) {
    const name = (e as { name?: string } | null)?.name;
    if (name === 'AbortError') return 'cancelled';
    if (name === 'NotAllowedError') return 'unsupported';
    throw e;
  }
}

// Open the pre-filled WhatsApp message.
//
// Returns false when the browser blocked the window, so the caller can say so
// instead of leaving the user staring at a button that appears to do nothing.
export function openWhatsappMessage(url: string): boolean {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  return opened !== null;
}
