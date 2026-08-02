// ============================================================================
// THE TRANSACTIONAL EMAIL PROVIDER
// ============================================================================
//
// WHERE THE API KEY LIVES — the single most important line in this build:
//
//   RESEND_API_KEY is read from process.env INSIDE THIS SERVERLESS FUNCTION,
//   and nowhere else in the repository. It is NOT `VITE_`-prefixed, so Vite
//   cannot inline it into the browser bundle even by accident; it is not passed
//   to the client, not returned in any response, and never logged. The browser
//   calls /api/statements/email with its own Supabase session and never learns
//   that Resend exists.
//
// The same rule the night-audit cron follows for the service-role key
// (api/cron/night-audit.ts §SECURITY). A key that reaches the browser is a key
// anyone can read from the bundle and use to send mail as this hotel.
//
// WHY RESEND: the simplest provider to stand up for a single hotel — one API
// key, one DNS verification, a free tier that comfortably covers a 30-room
// property's statements, and a plain REST endpoint that needs no SDK. It is
// deliberately reached through fetch rather than the npm package: one HTTP call
// with three fields is not worth a dependency, and swapping providers later is
// then a change to this file alone.
//
// EVERY FAILURE IS RETURNED, NEVER SWALLOWED (rule 11). The caller records it on
// the audit row and shows it to the desk verbatim.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// Resend accepts up to 40MB per message; a statement PDF is measured in tens of
// kilobytes. This ceiling exists so a pathological folio (a guest with thousands
// of lines) fails with a message the desk can act on rather than a provider
// error nobody can read.
const MAX_ATTACHMENT_BYTES = 8_000_000;

// Long enough for a provider having a slow minute, comfortably inside the
// function's own maxDuration so the timeout is OURS and the outcome is recorded.
const REQUEST_TIMEOUT_MS = 20_000;

export interface OutgoingStatementEmail {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  html: string;
  text: string;
  attachmentFilename: string;
  attachment: Buffer;
}

export type SendResult =
  | { ok: true; providerMessageId: string | null }
  | { ok: false; error: string };

export function providerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

export async function sendStatementEmail(
  message: OutgoingStatementEmail,
): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Fails closed, and says which knob is missing — an operator reading this in
    // a toast knows exactly what to set. No key material is ever echoed.
    return {
      ok: false,
      error: 'Email sending is not configured on this deployment (RESEND_API_KEY is unset).',
    };
  }

  if (message.attachment.length > MAX_ATTACHMENT_BYTES) {
    return {
      ok: false,
      error: 'This statement is too large to email as an attachment. Download the PDF and send it directly.',
    };
  }

  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: message.from,
        to: [message.to],
        // snake_case: this is the REST API, not the SDK's camelCase wrapper.
        ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        subject: message.subject,
        html: message.html,
        // A plain-text alternative is not decoration: a mail client that shows
        // only text would otherwise render an empty message above the bill, and
        // some spam filters score a text-less HTML mail down.
        text: message.text,
        attachments: [
          {
            filename: message.attachmentFilename,
            content: message.attachment.toString('base64'),
            type: 'application/pdf',
          },
        ],
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    // A network failure or our own timeout. NOTE what this does NOT tell us: a
    // request that timed out may still have been accepted. The caller records
    // the attempt as failed and says so plainly rather than claiming the mail
    // never went.
    const reason = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `The email provider could not be reached (${reason}).` };
  }

  const body = await response.text();
  if (!response.ok) {
    return { ok: false, error: `The email provider refused the message: ${providerError(body, response.status)}` };
  }

  let providerMessageId: string | null = null;
  try {
    const parsed = JSON.parse(body) as { id?: string };
    providerMessageId = typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    // Accepted but unparseable: the mail went, and the id is only ever used to
    // trace a delivery. Not worth failing a successful send over.
  }

  return { ok: true, providerMessageId };
}

// Resend answers an error as { "message": "...", "name": "..." }. Fall back to
// the raw body (capped) so an HTML error page from a proxy is still readable
// rather than being replaced by "unknown error".
function providerError(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as { message?: string; name?: string };
    if (parsed.message) return `${parsed.message} (${status})`;
  } catch {
    // fall through
  }
  const trimmed = body.trim();
  return trimmed.length > 0 ? `${trimmed.slice(0, 300)} (${status})` : `HTTP ${status}`;
}
