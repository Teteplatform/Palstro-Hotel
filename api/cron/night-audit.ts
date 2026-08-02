import { timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// ============================================================================
// THE NIGHT-AUDIT CRON (brief §2)
//
// Vercel calls this once a day; it walks every active property and runs
// run_night_audit (migration 023 §2) for each, which posts one room-night
// charge per in-house booking for the night that just ended.
//
// ----------------------------------------------------------------------------
// WHY THIS IS SAFE TO RETRY — AND WHY THAT IS THE WHOLE DESIGN
// ----------------------------------------------------------------------------
// Nothing here tracks whether the audit "already ran". It does not need to. Two
// layers make a repeat run a no-op:
//
//   1. post_room_night_charge (021 §9.2) builds a DETERMINISTIC idempotency key
//      'room:<booking_id>:<stay_date>' and passes it to post_charge, which
//      returns the EXISTING charge when that key is already present;
//   2. folio_charges_idem_uniq — a partial UNIQUE INDEX on
//      (tenant_id, idempotency_key) — is what actually enforces it, so even two
//      simultaneous invocations cannot both insert.
//
// So Vercel retrying a timed-out invocation, an operator re-triggering the
// endpoint by hand, or two regions firing at once all converge on exactly one
// charge per booking per night. The summary reports `posted: 0` on a re-run,
// which is how an operator confirms the retry changed nothing.
//
// ----------------------------------------------------------------------------
// TIMEZONES — the known limitation, stated rather than hidden
// ----------------------------------------------------------------------------
// Vercel cron schedules are UTC, and there is ONE schedule for all properties.
// It is set to 05:00 UTC = 06:00 Africa/Lagos, the default
// properties.night_audit_time, so the run lands at the cutoff for the properties
// this system currently serves.
//
// The BUSINESS DATE, though, is not derived here — run_night_audit derives it
// per property, as "yesterday in properties.timezone". That is correct at every
// hour of a property's own operating day, so a single fixed-time cron already
// bills the right night for any property whose local date has rolled over by the
// time the cron fires. The limitation is narrower than it looks: it is only a
// problem for a property far enough WEST that 05:00 UTC is still the previous
// local day (roughly UTC-5 and west), where the run would bill the night before
// last and the most recent night would wait until tomorrow's run.
//
// RECOMMENDED FIX WHEN PROPERTIES SPAN TIMEZONES — the simplest correct one, and
// deliberately NOT built now: change the schedule to hourly and add a filter so
// each property is audited only on the hour its own local clock passes its
// night_audit_time. Because the posting is idempotent, an over-eager or repeated
// run costs nothing, which is precisely what makes the hourly approach safe and
// keeps it a one-line schedule change plus a WHERE clause — no per-property
// scheduling, no state table, no queue.
//
// ----------------------------------------------------------------------------
// SECURITY — how this endpoint is protected
// ----------------------------------------------------------------------------
// It posts money to guest folios, so a public caller must never reach it.
//
//   * CRON_SECRET is set in the Vercel project's environment. Vercel's cron
//     scheduler automatically sends it as `Authorization: Bearer <CRON_SECRET>`
//     on every invocation of a cron path — nothing has to be configured on the
//     cron itself.
//   * Every request is required to carry that header, compared with
//     timingSafeEqual so the check leaks nothing through response timing.
//   * If CRON_SECRET is UNSET the endpoint refuses every request (500). It fails
//     CLOSED: a misconfigured deploy that silently accepted anonymous callers
//     would be far worse than one that visibly does not run.
//   * Only GET is exported, which is what the scheduler issues; any other method
//     is a 405 from the platform.
//   * The service-role key is read from a NON-VITE_ variable, so Vite can never
//     inline it into the browser bundle. It exists only in the server runtime.
//   * The response bodies carry no secrets and are marked no-store.
//
// Rule 11 throughout: every call is awaited in a try/catch, and a failure is
// reported in the response rather than swallowed — an unattended job that fails
// quietly is a hotel that stops billing its rooms and nobody notices.
// ============================================================================

export const config = {
  runtime: 'nodejs',
  // A 30-room property audits in well under a second; the ceiling is for a group
  // with many properties, and for a catch-up run after an outage.
  maxDuration: 60,
};

// The columns the run needs. `status`/`deleted_at` are filtered server-side;
// name and timezone are carried only so the per-property log line is readable.
interface ActiveProperty {
  id: string;
  name: string;
  timezone: string;
}

// The jsonb summary run_night_audit returns (023 §2). Kept structural rather than
// exhaustive: the endpoint logs the whole object and only reads the few fields it
// summarises, so adding a field to the RPC never breaks this file.
interface NightAuditSummary {
  property_id: string;
  property_name: string | null;
  business_date: string;
  in_house: number;
  posted: number;
  already_posted: number;
  error_count: number;
  not_checked_in_count: number;
  // Migration 024. not_yet_arrived: stays whose RESERVED range covered this
  // night but whose ACTUAL arrival was later — deliberately not billed, and
  // surfaced so that exclusion is visible rather than silent.
  // no_show_candidate_count: confirmed bookings whose reserved arrival has
  // passed. REPORTED ONLY — the cron never marks or charges a no-show, because
  // a 02:00 arrival is not a no-show and the charge is a commercial judgement.
  not_yet_arrived_count: number;
  no_show_candidate_count: number;
  no_show_candidates_truncated: boolean;
  amount_posted: string | number;
  [key: string]: unknown;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      // A cron result must never be served from a cache — a cached "ok" would
      // hide a run that never happened.
      'cache-control': 'no-store',
    },
  });
}

// Constant-time comparison of the presented bearer token against CRON_SECRET.
// Length is compared first (timingSafeEqual throws on a length mismatch), which
// leaks only the secret's length — not its content.
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorise(request: Request): Response | null {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    // FAIL CLOSED. Without the secret there is no way to tell Vercel's scheduler
    // from anyone on the internet, so nothing runs.
    console.error('[night-audit] CRON_SECRET is not set — refusing to run.');
    return jsonResponse(
      { ok: false, error: 'Cron is not configured on this deployment.' },
      500,
    );
  }

  const header = request.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!presented || !tokenMatches(presented, expected)) {
    // No detail in the body: an unauthorised caller learns nothing about why.
    return jsonResponse({ ok: false, error: 'Unauthorised.' }, 401);
  }

  return null;
}

export async function GET(request: Request): Promise<Response> {
  const denied = authorise(request);
  if (denied) return denied;

  // The URL is not a secret, so the client-side variable is accepted as a
  // fallback; the KEY is server-only and has no fallback by design.
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    console.error('[night-audit] Supabase server credentials are missing.');
    return jsonResponse(
      { ok: false, error: 'Supabase server credentials are not configured.' },
      500,
    );
  }

  // The service role bypasses RLS, which is what lets one call audit every
  // tenant's properties. It also satisfies the folio RPCs' staff gate via
  // is_service_role() (023 §1) — so the postings still go through the validated
  // RPC path (rate lock, folio-status check, idempotency index) rather than
  // around it. persistSession/autoRefreshToken off: this is a stateless
  // server invocation, and there is no storage of any kind (constraint).
  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const startedAt = new Date().toISOString();
  const summaries: NightAuditSummary[] = [];
  const failures: { property_id: string; property_name: string; error: string }[] =
    [];

  try {
    // Rule 1a: the property list is consumed IN FULL, so it is paged rather than
    // read unbounded — a hotel group past the row cap would otherwise have its
    // later properties silently skipped, and skipped properties simply do not
    // get billed. (The paging loop is inlined rather than imported from
    // src/lib/fetchAllPaged so this server function shares no module graph with
    // the browser bundle; the contract is identical.)
    const properties: ActiveProperty[] = [];
    const pageSize = 1000;
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('properties')
        .select('id, name, timezone')
        .eq('status', 'active')
        .is('deleted_at', null) // rule 5: NULL-safe soft-delete
        .order('name', { ascending: true })
        .range(from, from + pageSize - 1)
        .returns<ActiveProperty[]>();

      if (error) throw error;
      if (!data?.length) break;
      properties.push(...data);
      if (data.length < pageSize) break;
    }

    console.info(
      `[night-audit] ${startedAt} — auditing ${properties.length} active propert${
        properties.length === 1 ? 'y' : 'ies'
      }.`,
    );

    // SEQUENTIAL, not parallel, and deliberately so: each call is one database
    // transaction posting real money, and a serial walk keeps the connection
    // pool free for the guests and staff using the app at 06:00. Thirty
    // properties take seconds.
    for (const property of properties) {
      try {
        // p_business_date is left NULL: run_night_audit derives "yesterday" in
        // THIS property's own timezone. Passing a date computed here would use
        // the server's clock for every property at once, which is the exact bug
        // the per-property derivation exists to avoid.
        const { data, error } = await supabase.rpc('run_night_audit', {
          p_property_id: property.id,
          p_business_date: null,
        });
        if (error) throw error;

        const summary = data as NightAuditSummary;
        summaries.push(summary);

        // The per-property log line the brief asks for — one line an operator can
        // scan, with the full summary object beside it for the detail.
        console.info(
          `[night-audit] ${property.name} (${property.timezone}) — ` +
            `business date ${summary.business_date}: ` +
            `${summary.posted} posted, ${summary.already_posted} already posted, ` +
            `${summary.in_house} in-house, ${summary.error_count} error(s), ` +
            `${summary.not_checked_in_count} confirmed-but-not-checked-in.`,
          summary,
        );

        // Two conditions that are not failures of the RUN but do need a human:
        // a booking that could not be charged, and an arrival nobody processed.
        if (summary.error_count > 0) {
          console.error(
            `[night-audit] ${property.name}: ${summary.error_count} booking(s) could not be charged.`,
            summary.errors,
          );
        }
        if (summary.not_checked_in_count > 0) {
          console.warn(
            `[night-audit] ${property.name}: ${summary.not_checked_in_count} confirmed booking(s) ` +
              'spanned this night without being checked in — they were NOT charged. ' +
              'Check them in or mark them no-show.',
            summary.not_checked_in,
          );
        }
        // 024: arrivals that came later than they were reserved for. Not a
        // problem — this is the migration working — but logged so an operator
        // who notices in_house dropped can see exactly which nights were
        // excluded and why.
        if ((summary.not_yet_arrived_count ?? 0) > 0) {
          console.info(
            `[night-audit] ${property.name}: ${summary.not_yet_arrived_count} booking(s) reserved this ` +
              'night but the guest arrived later — those nights were correctly NOT charged.',
            summary.not_yet_arrived,
          );
        }
        // 024: no-show candidates. A standing queue of unresolved arrivals, not
        // a failure of this run — and NEVER auto-actioned here. If the list was
        // capped, the cap is stated rather than left to look like the whole set.
        if ((summary.no_show_candidate_count ?? 0) > 0) {
          console.warn(
            `[night-audit] ${property.name}: ${summary.no_show_candidate_count} confirmed booking(s) ` +
              'whose reserved arrival date has passed are unresolved no-show candidates. ' +
              'The front desk must check them in or mark them no-show — the audit never does either.' +
              (summary.no_show_candidates_truncated
                ? ' (Only the earliest 100 are listed below.)'
                : ''),
            summary.no_show_candidates,
          );
        }
      } catch (e) {
        // One property's failure must not abandon the others — the next hotel in
        // the group still needs billing. Recorded, logged, and reflected in the
        // response status so a monitor can see it.
        const message = e instanceof Error ? e.message : String(e);
        failures.push({
          property_id: property.id,
          property_name: property.name,
          error: message,
        });
        console.error(
          `[night-audit] ${property.name}: run_night_audit failed — ${message}`,
        );
      }
    }
  } catch (e) {
    // A failure to even LIST the properties means nothing was audited. Loud, and
    // a 500 so Vercel records the invocation as failed (rule 11).
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[night-audit] fatal — ${message}`);
    return jsonResponse(
      { ok: false, started_at: startedAt, error: message },
      500,
    );
  }

  const bookingErrors = summaries.reduce((n, s) => n + (s.error_count ?? 0), 0);
  const ok = failures.length === 0 && bookingErrors === 0;

  return jsonResponse(
    {
      ok,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      properties_audited: summaries.length,
      properties_failed: failures.length,
      charges_posted: summaries.reduce((n, s) => n + (s.posted ?? 0), 0),
      charges_already_posted: summaries.reduce(
        (n, s) => n + (s.already_posted ?? 0),
        0,
      ),
      booking_errors: bookingErrors,
      // Rolled up across every property so a monitor can alert on the queue of
      // unresolved arrivals without parsing the per-property summaries (024).
      no_show_candidates: summaries.reduce(
        (n, s) => n + (s.no_show_candidate_count ?? 0),
        0,
      ),
      // The whole per-property summary set, so a failed run is diagnosable from
      // the response alone without opening the logs.
      properties: summaries,
      failures,
    },
    // 207-style semantics without inventing one: a partial failure is still a
    // completed invocation, but it must not read as a clean success to a monitor.
    ok ? 200 : 500,
  );
}
