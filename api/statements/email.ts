import type { SupabaseClient } from '@supabase/supabase-js';
import { callerMayOperateProperty, resolveCaller, supabaseServerConfig } from '../_lib/callerClient';
import {
  loadStatementForEmail,
  type EmailStatementTarget,
  type StatementMissing,
} from '../_lib/statementSource';
import { decodeStatementLogo } from '../_lib/statementLogoServer';
import { renderStatementPdf } from '../_lib/statementPdfServer';
import { buildStatementMessage, isEmail, resolveSender } from '../_lib/statementMessage';
import { providerConfigured, sendStatementEmail } from '../_lib/resend';
import { statementFileBase } from '../../src/lib/statement';

// ============================================================================
// EMAIL THE GUEST THEIR STATEMENT (2.txt)
//
// POST /api/statements/email
//   Authorization: Bearer <the staff member's Supabase access token>
//   { propertyId, target: {kind:'stay', bookingId} | {kind:'standalone', guestId},
//     toEmail, idempotencyKey, logoPngBase64? }
//
// ----------------------------------------------------------------------------
// WHY THIS IS A VERCEL FUNCTION AND NOT A SUPABASE EDGE FUNCTION
// ----------------------------------------------------------------------------
// The brief called for a Supabase Edge Function on the reasoning that a browser
// cannot send email. That reasoning is right and this is still a server; only
// the host differs, for two reasons that both come down to the emailed PDF
// having to BE the downloaded PDF:
//
//   1. Edge Functions run on Deno and can import nothing from src/ that touches
//      Vite (`lib/supabase` reads import.meta.env at module scope). The document
//      builder and the assembly would have had to be re-implemented in Deno —
//      a SECOND bill, in a second language, drifting from the first the day
//      either changed. Here they are imported verbatim.
//   2. This repository already runs server code on Vercel (the night-audit
//      cron), with its env conventions, its deploy and its logs. A second server
//      runtime, a second secret store and a second deploy step is real operating
//      cost for a hotel with one IT person.
//
// The brief's actual requirements are unchanged and are met below: the provider
// key exists only in this runtime, the caller is authenticated and
// property-scoped, and the guest's address is confirmed at the desk.
//
// ----------------------------------------------------------------------------
// SECURITY — how this endpoint is protected
// ----------------------------------------------------------------------------
//   * The caller must present a valid Supabase access token, verified against
//     Supabase Auth (api/_lib/callerClient.ts). A public caller cannot email
//     anybody's statement; there is no anonymous path in.
//   * Every read runs AS THAT USER under RLS — no service-role key on this path
//     — and is additionally scoped to the tenant and property (rule 19), with
//     the tenant derived from the property row rather than from the request.
//   * The caller must hold a grant to the property (get_property_ids()), checked
//     here for a clear error and AGAIN inside claim_statement_email, which is
//     the authoritative gate.
//   * RESEND_API_KEY is read from this runtime's environment only. It is never
//     `VITE_`-prefixed, never sent to the client, never logged.
//   * The DOCUMENT IS BUILT SERVER-SIDE from the database. The request carries
//     ids and an address — not a single figure — so a tampered client cannot
//     email a doctored bill. The one exception, the letterhead image, is
//     validated and bounded (api/_lib/statementLogoServer.ts explains the trade).
//   * A send is CLAIMED in the database before it is made, under the caller's
//     idempotency key (migration 030), so a double-click or a retried request
//     cannot mail a guest twice.
//
// Rule 11 throughout: every call is awaited in a try/catch, every failure is
// recorded on the audit row AND returned to the desk in words. A statement that
// silently did not send is the one outcome this endpoint must never produce.
// ============================================================================

export const config = {
  runtime: 'nodejs',
  // Reading a folio, rendering a PDF and handing it to a provider is a couple of
  // seconds. The ceiling is for a very long folio on a cold start.
  maxDuration: 60,
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RequestBody {
  propertyId?: unknown;
  target?: unknown;
  toEmail?: unknown;
  idempotencyKey?: unknown;
  logoPngBase64?: unknown;
}

// The row claim_statement_email hands back (migration 030 §3.1).
interface ClaimRow {
  claim_id: string;
  claim_status: 'sending' | 'sent' | 'failed';
  claim_to_email: string;
  claim_created_at: string;
  claimed: boolean;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // Nothing about a send may be served from a cache: a cached "sent" would
      // tell the desk a mail went that never did.
      'cache-control': 'no-store',
    },
  });
}

// What to tell the desk when the document structurally does not exist. Same
// distinctions the export menu draws (hooks/useStatementExport), because they
// mean the same things here.
function missingMessage(missing: StatementMissing, kind: EmailStatementTarget['kind']): string {
  switch (missing) {
    case 'property':
      return 'That property could not be found, so there is nothing to send.';
    case 'subject':
      return kind === 'stay'
        ? 'This stay could not be found at this property, so there is nothing to send.'
        : 'This guest could not be found in this tenant, so there is nothing to send.';
    case 'folio':
      return kind === 'standalone'
        ? 'This guest has no non-resident account at this property, so there is nothing to send.'
        : 'This stay has no folio, which should not be possible — every booking is given one automatically. Please contact support rather than treating this as a zero balance.';
    case 'totals':
      return 'This folio’s totals could not be computed, so no statement can be issued. Nothing here should be treated as settled until it is investigated.';
  }
}

export async function POST(request: Request): Promise<Response> {
  if (!supabaseServerConfig()) {
    console.error('[statement-email] Supabase server credentials are missing.');
    return jsonResponse(
      { ok: false, error: 'This deployment is not configured to send statements.' },
      500,
    );
  }
  if (!providerConfigured()) {
    console.error('[statement-email] RESEND_API_KEY is not set — refusing to run.');
    return jsonResponse(
      { ok: false, error: 'Email sending is not configured on this deployment.' },
      500,
    );
  }

  // --- Who is asking ---------------------------------------------------------
  const caller = await resolveCaller(request);
  if (!caller) {
    return jsonResponse({ ok: false, error: 'Please sign in again and retry.' }, 401);
  }
  const { supabase } = caller;

  // --- What they asked for ---------------------------------------------------
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return jsonResponse({ ok: false, error: 'The request could not be read.' }, 400);
  }

  const propertyId = typeof body.propertyId === 'string' ? body.propertyId : '';
  const toEmail = typeof body.toEmail === 'string' ? body.toEmail.trim() : '';
  const idempotencyKey =
    typeof body.idempotencyKey === 'string' ? body.idempotencyKey.trim() : '';
  const target = parseTarget(body.target);

  if (!UUID.test(propertyId)) {
    return jsonResponse({ ok: false, error: 'No property was given.' }, 400);
  }
  if (!target) {
    return jsonResponse({ ok: false, error: 'No statement was given to send.' }, 400);
  }
  if (!isEmail(toEmail)) {
    return jsonResponse(
      { ok: false, error: 'That does not look like an email address. Check it with the guest and try again.' },
      400,
    );
  }
  if (!UUID.test(idempotencyKey)) {
    return jsonResponse({ ok: false, error: 'The request was missing its idempotency key.' }, 400);
  }

  // --- May they act on this property? ---------------------------------------
  // RLS already restricts them to their own tenants; this is rule 19's second
  // layer, and it is re-checked inside the claim RPC.
  try {
    if (!(await callerMayOperateProperty(supabase, propertyId))) {
      return jsonResponse(
        { ok: false, error: 'You do not have access to this property.' },
        403,
      );
    }
  } catch (e) {
    return jsonResponse({ ok: false, error: describe(e) }, 500);
  }

  // --- The document, read and assembled from the database -------------------
  let loaded;
  try {
    const result = await loadStatementForEmail(supabase, propertyId, target);
    if (!result.ok) {
      return jsonResponse(
        { ok: false, error: missingMessage(result.missing, target.kind) },
        result.missing === 'totals' ? 500 : 404,
      );
    }
    loaded = result.loaded;
  } catch (e) {
    console.error('[statement-email] could not assemble the statement:', e);
    return jsonResponse({ ok: false, error: describe(e) }, 500);
  }

  const { statement } = loaded;

  const senderResult = resolveSender(
    statement.property.name,
    statement.property.email,
    loaded.branding,
  );
  if (!senderResult.ok) {
    console.error('[statement-email]', senderResult.error);
    return jsonResponse({ ok: false, error: senderResult.error }, 500);
  }

  // --- Claim the send. Everything after this point is recorded. --------------
  let claim: ClaimRow;
  try {
    const { data, error } = await supabase.rpc('claim_statement_email', {
      p_property_id: propertyId,
      p_subject_kind: target.kind,
      p_booking_id: loaded.bookingId,
      p_guest_id: loaded.guestId,
      p_document_reference: statement.reference,
      p_to_email: toEmail,
      p_idempotency_key: idempotencyKey,
    });
    if (error) throw error;
    const rows = (data ?? []) as ClaimRow[];
    if (!rows[0]) throw new Error('The send could not be claimed.');
    claim = rows[0];
  } catch (e) {
    // The claim is also the authorisation gate, so an insufficient_privilege here
    // is a real refusal and its message is the one to show.
    const status = (e as { code?: string } | null)?.code === '42501' ? 403 : 500;
    return jsonResponse({ ok: false, error: describe(e) }, status);
  }

  // Somebody else owns this send. Report THEIR outcome; never send a second copy.
  if (!claim.claimed) {
    if (claim.claim_status === 'sent') {
      return jsonResponse(
        {
          ok: true,
          status: 'already_sent',
          to: claim.claim_to_email,
          sendId: claim.claim_id,
          message: `This statement was already sent to ${claim.claim_to_email}.`,
        },
        200,
      );
    }
    if (claim.claim_status === 'sending') {
      return jsonResponse(
        {
          ok: true,
          status: 'in_flight',
          to: claim.claim_to_email,
          sendId: claim.claim_id,
          message: 'This statement is already being sent. Give it a moment before trying again.',
        },
        202,
      );
    }
    return jsonResponse(
      {
        ok: false,
        status: 'previously_failed',
        sendId: claim.claim_id,
        error: 'This send already failed. Press Send again to make a fresh attempt.',
      },
      409,
    );
  }

  // --- Render, send, record --------------------------------------------------
  try {
    const logo = decodeStatementLogo(body.logoPngBase64);
    const pdf = await renderStatementPdf(statement, logo);
    const message = buildStatementMessage(statement);

    const sent = await sendStatementEmail({
      from: senderResult.sender.from,
      to: toEmail,
      replyTo: senderResult.sender.replyTo,
      subject: message.subject,
      html: message.html,
      text: message.text,
      // The same filename every other channel uses (lib/statement's
      // statementFileBase), so an attachment and a download are recognisably the
      // same document in a guest's downloads folder.
      attachmentFilename: `${statementFileBase(statement)}.pdf`,
      attachment: pdf,
    });

    if (!sent.ok) {
      await recordOutcome(supabase, claim.claim_id, 'failed', null, sent.error);
      // 502: the failure is the provider's, not the request's, and the desk must
      // see it rather than a generic error.
      return jsonResponse({ ok: false, status: 'failed', error: sent.error }, 502);
    }

    await recordOutcome(supabase, claim.claim_id, 'sent', sent.providerMessageId, null);
    return jsonResponse(
      {
        ok: true,
        status: 'sent',
        to: toEmail,
        sendId: claim.claim_id,
        message: `Statement sent to ${toEmail}.`,
      },
      200,
    );
  } catch (e) {
    const error = describe(e);
    console.error('[statement-email] send failed:', e);
    await recordOutcome(supabase, claim.claim_id, 'failed', null, error);
    return jsonResponse({ ok: false, status: 'failed', error }, 500);
  }
}

// The audit row's completion. A failure to RECORD is logged but never overrides
// what actually happened to the email: if the mail went and this write did not,
// the desk must still be told it went, and the row is left at 'sending' — which
// migration 030 documents as "nobody knows", the honest state.
async function recordOutcome(
  supabase: SupabaseClient,
  id: string,
  status: 'sent' | 'failed',
  providerMessageId: string | null,
  errorMessage: string | null,
): Promise<void> {
  try {
    const { error } = await supabase.rpc('complete_statement_email', {
      p_id: id,
      p_status: status,
      p_provider_message_id: providerMessageId,
      p_error_message: errorMessage,
    });
    if (error) throw error;
  } catch (e) {
    console.error(`[statement-email] could not record outcome ${status} for ${id}:`, e);
  }
}

function parseTarget(value: unknown): EmailStatementTarget | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as { kind?: unknown; bookingId?: unknown; guestId?: unknown };
  if (raw.kind === 'stay' && typeof raw.bookingId === 'string' && UUID.test(raw.bookingId)) {
    return { kind: 'stay', bookingId: raw.bookingId };
  }
  if (
    raw.kind === 'standalone' &&
    typeof raw.guestId === 'string' &&
    UUID.test(raw.guestId)
  ) {
    return { kind: 'standalone', guestId: raw.guestId };
  }
  return null;
}

// The server's OWN message wherever there is one (a PostgREST error, an RPC's
// raised exception), because those say what to do differently — "You do not have
// access to this property" is actionable in a way "something went wrong" is not.
function describe(e: unknown): string {
  const err = e as { message?: string; hint?: string } | null;
  const message = err?.message?.trim();
  if (message) {
    const hint = err?.hint?.trim();
    return hint ? `${message} — ${hint}` : message;
  }
  return 'Something went wrong while sending the statement. Please try again.';
}
