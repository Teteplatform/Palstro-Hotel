import type { StatementData } from '../../src/lib/statement';
import { statementBalanceLabel } from '../../src/lib/export/statementSections';
import { formatMoney } from '../../src/lib/format';
import { formatDisplayDate } from '../../src/lib/date';
import { formatNights } from '../../src/lib/bookingLabels';
import { brandingString } from '../../src/lib/branding';
import type { PropertyBranding } from '../../src/types/tenant';

// ============================================================================
// THE EMAIL ITSELF — WHO IT COMES FROM, AND WHAT IT SAYS
// ============================================================================
//
// Short and professional, because the DOCUMENT is the attachment: a wall of
// text above a PDF that repeats it is noise. The body carries the four things
// that let a guest recognise the mail without opening anything — who it is
// from, which stay, what the balance is, and that the statement is attached.
//
// EVERY FIGURE IS READ OFF THE SAME ASSEMBLED STATEMENT the PDF is built from,
// through the same lib/format helpers the screen uses. A covering note quoting a
// different balance from the bill attached beneath it is precisely the failure
// this whole build exists to prevent.
//
// NO TENANT COPY IS WRITTEN HERE (rule 17). The hotel's name, address, phone,
// currency, closing line and payment note all arrive from the database; what is
// hardcoded is generic English that would read the same for any hotel in any
// country.

export interface StatementMessage {
  subject: string;
  html: string;
  text: string;
}

// ---------------------------------------------------------------------------
// The sender
// ---------------------------------------------------------------------------

// A property may name its own sending address in property_settings.branding.
// Freeform JSONB, tenant-authored, same accessor as the statement's footer note.
const BRANDING_FROM_EMAIL_KEY = 'statement_from_email';

export interface Sender {
  // RFC 5322 "Display Name <address>". The display name is ALWAYS the property's
  // own, so the mail reads as coming from the hotel even when the address is the
  // platform's.
  from: string;
  // Where a reply goes. The hotel's own address, always, so a guest who hits
  // Reply reaches the desk and not a no-reply mailbox — this is what makes the
  // platform-sender fallback acceptable rather than merely tolerable.
  replyTo: string | null;
}

export type SenderResult =
  | { ok: true; sender: Sender }
  | { ok: false; error: string };

// WHERE THE ADDRESS COMES FROM, AND THE DOMAIN VERIFICATION BEHIND IT.
//
// Resend (like every transactional provider) will only send from a domain the
// account has verified with DNS records. A hotel that has not verified
// heledonhotels.com cannot send as statements@heledonhotels.com — the provider
// rejects the request outright, which would turn "email the guest" into a
// permanent error the desk cannot fix from inside the app.
//
// So the address resolves in two steps:
//   1. the property's own configured address, used ONLY if its domain appears in
//      STATEMENT_SENDER_DOMAINS (the domains verified on the platform's Resend
//      account);
//   2. otherwise STATEMENT_FROM_EMAIL — the platform's verified sender.
// Either way the display name is the property's name and Reply-To is the
// property's own email, so the guest sees the hotel and replies reach the hotel.
// When a hotel verifies its domain, adding it to STATEMENT_SENDER_DOMAINS makes
// their configured address live with no code change.
export function resolveSender(
  propertyName: string,
  propertyEmail: string | null,
  branding: PropertyBranding,
): SenderResult {
  const fallback = (process.env.STATEMENT_FROM_EMAIL ?? '').trim();
  if (!isEmail(fallback)) {
    // Fails CLOSED and loudly: without a verified sender there is no honest
    // "from" to put on a guest's bill, and guessing one would have every send
    // rejected by the provider anyway.
    return {
      ok: false,
      error:
        'No sending address is configured for this deployment. Set STATEMENT_FROM_EMAIL to a verified sender.',
    };
  }

  const configured = (brandingString(branding, BRANDING_FROM_EMAIL_KEY) ?? '').trim();
  const verified = (process.env.STATEMENT_SENDER_DOMAINS ?? '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
  const domain = configured.split('@')[1]?.toLowerCase() ?? '';
  const address =
    isEmail(configured) && verified.includes(domain) ? configured : fallback;

  return {
    ok: true,
    sender: {
      from: `${quoteDisplayName(propertyName)} <${address}>`,
      replyTo: propertyEmail && isEmail(propertyEmail) ? propertyEmail : null,
    },
  };
}

export function isEmail(value: string): boolean {
  // Deliberately the SAME shape as the CHECK constraint on
  // statement_emails.to_email and the browser's own check: no whitespace either
  // side of a single @, and a dot in the domain. Anything cleverer rejects real
  // addresses; anything looser lets a header-injecting string through.
  return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

// A display name inside a From header. Quotes and control characters are
// stripped rather than escaped: a hotel name containing a CR or LF would let a
// caller inject a header (a Bcc, another From) into the message, and no real
// property name needs either character.
function quoteDisplayName(name: string): string {
  const clean = name.replace(/[\r\n"\\]+/g, ' ').trim();
  return clean.length > 0 ? `"${clean}"` : '"Statement"';
}

// ---------------------------------------------------------------------------
// The message
// ---------------------------------------------------------------------------

export function buildStatementMessage(statement: StatementData): StatementMessage {
  const { property, guest, stay, totals, balance } = statement;
  const currency = property.currency;

  const subject = `Your statement from ${property.name} — ${statement.referenceLabel} ${statement.reference}`;

  const stayLine = stay
    ? `${stay.arrived ? 'Arrived' : 'Arriving'} ${formatDisplayDate(stay.checkIn)} · Departing ${formatDisplayDate(
        stay.checkOut,
      )} (${formatNights(stay.nights)})`
    : null;

  // The same three figures the WhatsApp summary carries, in the same order, for
  // the same reason: a guest wants the outcome, and the attachment has the
  // itemisation.
  const figures: { label: string; value: string; strong?: boolean }[] = [
    { label: 'Total charges', value: formatMoney(totals.charges, currency) },
  ];
  if (totals.payments !== 0) {
    figures.push({
      label: 'Payments received',
      value: formatMoney(totals.payments, currency),
    });
  }
  figures.push({
    label: statementBalanceLabel(balance.state),
    // The magnitude beside the state's own WORD, exactly as every other channel
    // prints it — never a bare minus sign a guest has to interpret.
    value: formatMoney(Math.abs(balance.amount), currency),
    strong: true,
  });

  const contact = [property.phone, property.email].filter(Boolean).join(' · ');

  const text = [
    `Dear ${guest.name},`,
    '',
    `Your statement from ${property.name} is attached as a PDF.`,
    `${statement.referenceLabel} ${statement.reference} · ${formatDisplayDate(statement.issueDate)}`,
    ...(stayLine ? ['', stayLine] : []),
    '',
    ...figures.map((f) => `${f.label}: ${f.value}`),
    '',
    statement.footer.thankYou,
    ...(statement.footer.note ? ['', statement.footer.note] : []),
    '',
    property.name,
    ...(property.address ? [property.address] : []),
    ...(contact ? [contact] : []),
  ].join('\n');

  // Inline styles and a table-free layout: every mail client strips <style>
  // blocks, and half of them mangle flexbox. This renders the same in Gmail, in
  // Outlook and in a plain-text-preferring client (which gets `text` above).
  const html = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1f1f1f;max-width:520px">
  <p style="margin:0 0 16px">Dear ${escapeHtml(guest.name)},</p>
  <p style="margin:0 0 16px">Your statement from <strong>${escapeHtml(property.name)}</strong> is attached as a PDF.</p>
  <p style="margin:0 0 16px;color:#5c5c5c;font-size:13px">
    ${escapeHtml(statement.referenceLabel)} ${escapeHtml(statement.reference)} · ${escapeHtml(formatDisplayDate(statement.issueDate))}${
      stayLine ? `<br>${escapeHtml(stayLine)}` : ''
    }
  </p>
  <div style="margin:0 0 16px;padding:12px 16px;background:#f6f3ee;border-radius:8px">
    ${figures
      .map(
        (f) =>
          `<div style="margin:2px 0${f.strong ? ';font-weight:700' : ''}">${escapeHtml(
            f.label,
          )}: ${escapeHtml(f.value)}</div>`,
      )
      .join('\n    ')}
  </div>
  <p style="margin:0 0 16px">${escapeHtml(statement.footer.thankYou)}</p>
  ${
    statement.footer.note
      ? `<p style="margin:0 0 16px;color:#5c5c5c;font-size:13px">${escapeHtml(statement.footer.note)}</p>`
      : ''
  }
  <p style="margin:16px 0 0;padding-top:12px;border-top:1px solid #d8d0c4;color:#5c5c5c;font-size:13px">
    <strong style="color:#1f1f1f">${escapeHtml(property.name)}</strong>${
      property.address ? `<br>${escapeHtml(property.address)}` : ''
    }${contact ? `<br>${escapeHtml(contact)}` : ''}
  </p>
</div>`;

  return { subject, html, text };
}

// Everything interpolated into the HTML above is tenant data or a guest's name —
// free text somebody typed — so all of it is escaped. An apostrophe in a hotel's
// name must not be able to close an attribute.
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
