import { supabase } from './supabase';
import type { StatementData } from './statement';
import type { StatementTarget } from './statementLoad';
import type { StatementEmail } from '../types/statementEmail';

// ===========================================================================
// SENDING THE STATEMENT BY EMAIL — THE BROWSER'S HALF
// ===========================================================================
//
// A browser cannot send email, so this is the one export that leaves the tab:
// it posts to /api/statements/email (a Vercel Node function) and that function
// reads the folio, renders the PDF and hands it to the provider.
//
// WHAT CROSSES THE WIRE IS DELIBERATELY THIN: which property, which stay or
// guest, the address to send to, and an idempotency key. NOT the statement, NOT
// a total, NOT a line — the server re-reads all of it under this user's own RLS
// and assembles the document with the same assembleStatement the screen renders.
// So a tampered client cannot email a doctored bill, and the emailed PDF is the
// downloaded PDF.
//
// THE ONE EXCEPTION is the letterhead image, and it travels because it has to:
// every stored variant is WebP, PDF cannot embed WebP, and only a browser has a
// canvas to re-encode it as PNG. The server validates and bounds what arrives
// (api/_lib/statementLogoServer.ts sets out the trade in full). Without it, an
// emailed statement would systematically differ from the printed one — a
// different letterhead on the same bill.
//
// NO PROVIDER KEY IS ANYWHERE NEAR THIS FILE. The browser does not know which
// provider sends the mail; the key exists only in the function's environment.
//
// NOTHING IS STORED (constraint): no localStorage, no sessionStorage. The
// session token comes from the live Supabase client and is used for one request.

export type StatementEmailOutcome =
  // The provider accepted it.
  | { status: 'sent'; to: string; message: string }
  // Another attempt under the same key already sent it — a double-click, or a
  // retry of a request that actually succeeded. Reported as success because the
  // guest has their statement, which is the thing the desk needs to know.
  | { status: 'already_sent'; to: string; message: string }
  // A send under this key is still in flight.
  | { status: 'in_flight'; to: string; message: string };

// A failure the desk must read verbatim (rule 11): the provider's refusal, an
// RPC's own message, a network drop. Distinguished from a programming error so
// the dialog can show it as advice rather than as a crash.
//
// `status` carries the endpoint's own word for the failure when it has one.
// 'previously_failed' is the load-bearing case: it means an earlier attempt
// under THIS idempotency key already failed, so retrying needs a new key — the
// caller mints one rather than pressing a button that can only fail again.
export class StatementEmailError extends Error {
  readonly status?: string;

  constructor(message: string, status?: string) {
    super(message);
    this.status = status;
  }
}

export interface SendStatementEmailInput {
  propertyId: string;
  target: StatementTarget;
  // The assembled document — used ONLY to decode the letterhead logo. Every
  // printed value is re-read server-side.
  statement: StatementData;
  toEmail: string;
  // A fresh key per send INTENT (crypto.randomUUID, lib/folio's convention). It
  // collapses a double-click or a retried request onto one email; a deliberate
  // second attempt after a failure is a new intent and gets a new key.
  idempotencyKey: string;
}

interface EndpointResponse {
  ok?: boolean;
  status?: string;
  to?: string;
  message?: string;
  error?: string;
}

export async function sendStatementEmail(
  input: SendStatementEmailInput,
): Promise<StatementEmailOutcome> {
  // The caller's own access token. The endpoint runs every read as this user, so
  // an expired session must be caught here rather than surfacing as a confusing
  // "not found" from the server.
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) throw sessionError;
  const token = sessionData.session?.access_token;
  if (!token) {
    throw new StatementEmailError(
      'Your session has expired. Please sign in again and retry.',
    );
  }

  const payload = {
    propertyId: input.propertyId,
    target: input.target,
    toEmail: input.toEmail,
    idempotencyKey: input.idempotencyKey,
    logoPngBase64: await encodeLogo(input.statement.property.logoUrl),
  };

  let response: Response;
  try {
    response = await fetch('/api/statements/email', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // A dropped network, or the endpoint not running (it is a serverless
    // function: `vite dev` does not serve it — use `vercel dev` or a deployment).
    throw new StatementEmailError(
      'Could not reach the server. Check the connection and try again — the statement was NOT sent.',
    );
  }

  let body: EndpointResponse;
  try {
    body = (await response.json()) as EndpointResponse;
  } catch {
    // A non-JSON body means something upstream answered instead of the function.
    throw new StatementEmailError(
      `The server returned an unexpected response (HTTP ${response.status}). The statement may not have been sent — check the guest's inbox before retrying.`,
    );
  }

  if (!response.ok || body.ok !== true) {
    throw new StatementEmailError(
      body.error ?? `The statement could not be sent (HTTP ${response.status}).`,
      body.status,
    );
  }

  const to = body.to ?? input.toEmail;
  const status =
    body.status === 'already_sent' || body.status === 'in_flight' ? body.status : 'sent';
  return {
    status,
    to,
    message: body.message ?? `Statement sent to ${to}.`,
  };
}

// The letterhead, decoded to PNG the way every other export decodes it — the
// same memoised helper, so a desk that downloads the PDF and then emails it
// re-encodes nothing. Null when there is no logo, or when it could not be
// decoded: the document then prints the property NAME as its wordmark, exactly
// as the screen and the download do, and the send is never failed over a picture.
async function encodeLogo(logoUrl: string | null): Promise<string | null> {
  if (!logoUrl) return null;
  try {
    const [{ loadStatementLogo }, { bytesToBase64 }] = await Promise.all([
      import('./export/logo'),
      import('./export/download'),
    ]);
    const logo = await loadStatementLogo(logoUrl);
    return logo ? bytesToBase64(logo.png) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// "Did the guest get their bill?"
// ---------------------------------------------------------------------------

// The most recent SUCCESSFUL send for one statement, or null. Shown in the send
// dialog so the desk can see they are about to send a second copy, and to which
// address the first one went.
//
// NOT A LIST SURFACE, so rule 1b's pager does not apply: this is one fact — the
// latest send — not a browse over history. It is bounded by construction
// (`.limit(1)` after an explicit ordering), which is the shape rule 1b exists to
// distinguish from a capped list with no way to reach the rest.
//
// Ordered by business_date (rule 8), with created_at only as the tiebreak within
// a day.
export async function fetchLastStatementEmail(
  target: StatementTarget,
  tenantId: string,
  propertyId: string,
): Promise<StatementEmail | null> {
  let query = supabase
    .from('statement_emails')
    .select('*')
    .eq('tenant_id', tenantId) // rule 19
    .eq('property_id', propertyId) // rule 19
    .eq('status', 'sent');

  if (target.kind === 'stay') {
    query = query.eq('booking_id', target.bookingId);
  } else {
    // guest_id is recorded on both kinds, so a standalone lookup must also
    // exclude the guest's STAY sends — those are different documents.
    query = query.eq('guest_id', target.guestId).is('booking_id', null);
  }

  const { data, error } = await query
    .order('business_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return (data ?? null) as StatementEmail | null;
}
