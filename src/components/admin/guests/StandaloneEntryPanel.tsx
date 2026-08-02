import { useEffect, useState } from 'react';
import { describeError } from '../../../lib/errors';
import { newIdempotencyKey } from '../../../lib/folio';
import { openGuestFolio } from '../../../lib/guestLedger';
import { AddChargeForm } from '../folio/AddChargeForm';
import { TakePaymentForm } from '../folio/TakePaymentForm';

// STANDALONE CHARGE / PAYMENT (2.txt §2) — money that belongs to the GUEST but
// to no stay.
//
// ---------------------------------------------------------------------------
// THE MODEL: A PROPERTY-LEVEL GUEST FOLIO (migration 028 §1–§2)
// ---------------------------------------------------------------------------
// The guest gets ONE folio at this property that has no booking:
// folios.booking_id becomes NULL and folios.guest_id names them, with a database
// CHECK that exactly one of the two is set and a partial unique index that makes
// a second such folio impossible. open_guest_folio is a get-or-create — the desk
// never "opens a folio", they charge a walk-in for the bar tab, and the folio is
// how the system holds it.
//
// WHY A FOLIO AND NOT A NEW TABLE: a charge and a payment already have exactly
// one home, and post_charge / record_payment already take a folio_id. A separate
// "guest charges" table would mean a second posting path, a second tax
// computation, a second void path and a second balance — the exact failure the
// shared folio engine exists to prevent. Giving the EXISTING folio a second kind
// of owner costs one nullable column and changes no function at all: the charge
// below goes through the same unchanged post_charge, the payment through the
// same unchanged record_payment, and folio_totals values the folio identically.
//
// HOW IT RECONCILES: the guest's payment pool is Σ non-voided payments across
// ALL their folios here (028 §4), and each standalone charge joins the FIFO
// ordering as its own item dated by its business date (028 §5). So a standalone
// payment settles their oldest unpaid stay first, exactly as a payment taken at
// the desk does, and the invariant still closes:
//   guest_account_summary.guest_balance
//     = the last guest_ledger.running_balance
//     = Σ folio_totals(f).balance over every folio the guest has here.
//
// ---------------------------------------------------------------------------
// THE FOLIO IS RESOLVED WHEN THE PANEL OPENS, not when the form is submitted, so
// the form below can be the ordinary one (it takes a folio id). An empty
// standalone folio left behind by a cancelled form costs one row and nothing
// else — the same judgement 021 DECISION 1 makes about opening a folio for an
// enquiry — and the next attempt gets that same row back rather than a second.

type Mode = 'charge' | 'payment';

interface StandaloneEntryPanelProps {
  guestId: string;
  guestName: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function StandaloneEntryPanel({
  guestId,
  guestName,
  tenantId,
  propertyId,
  currency,
  timezone,
  onDone,
  onCancel,
}: StandaloneEntryPanelProps) {
  const [mode, setMode] = useState<Mode>('charge');
  const [folioId, setFolioId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Resolve (get-or-create) the guest's standalone folio once, on open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const folio = await openGuestFolio(
          tenantId,
          propertyId,
          guestId,
          // A key per open attempt (rule 2). The real guard is the database's
          // folios_guest_standalone_uniq index, which is stronger: it makes a
          // second standalone folio impossible however the request arrives.
          newIdempotencyKey(),
        );
        if (cancelled) return;
        setFolioId(folio.id);
        setError(null);
      } catch (e) {
        // Rule 11: the real diagnostic. Without a folio there is nothing to post
        // to, so the panel says why rather than showing a form that cannot work.
        if (!cancelled) setError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId, guestId]);

  if (error) {
    return (
      <section className="rounded-2xl border border-sand-border bg-white/70 p-4">
        <h3 className="text-sm font-semibold text-charcoal">
          Standalone charge / payment
        </h3>
        <p className="mt-2 text-sm text-charcoal-muted">{error}</p>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            Close
          </button>
        </div>
      </section>
    );
  }

  if (!folioId) {
    return (
      <p
        className="rounded-2xl border border-sand-border bg-white/70 p-4 text-sm text-charcoal-muted"
        aria-live="polite"
      >
        Opening this guest's standalone account…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* The two kinds, as a real choice rather than two buttons above the
          table: they share every other field, and splitting them into separate
          entry points would double the surface for one boolean. */}
      <div
        role="radiogroup"
        aria-label="Standalone entry type"
        className="flex flex-wrap items-center gap-2"
      >
        <ModeButton
          selected={mode === 'charge'}
          onClick={() => setMode('charge')}
          label="Charge"
        />
        <ModeButton
          selected={mode === 'payment'}
          onClick={() => setMode('payment')}
          label="Payment"
        />
      </div>

      {mode === 'charge' ? (
        <AddChargeForm
          folioId={folioId}
          tenantId={tenantId}
          propertyId={propertyId}
          currency={currency}
          timezone={timezone}
          title="Standalone charge"
          description={`Charged to ${guestName}'s account at this property, tied to no stay — a non-resident bar tab, a hall hire, a late charge after departure. It appears on their ledger as its own line and counts towards their outstanding balance.`}
          descriptionLabel="What this charge is for"
          descriptionRequired
          descriptionPlaceholder="e.g. Bar tab, 14 Aug — not staying"
          descriptionHelp="Required. A charge tied to no stay is unexplainable a month later without it, and this is what prints on the guest's statement."
          // Provenance: free text by design (021 §5), so a later report can tell
          // a non-resident charge from a front-desk extra without inspecting the
          // folio it landed on.
          source="standalone"
          onDone={onDone}
          onCancel={onCancel}
        />
      ) : (
        <TakePaymentForm
          folioId={folioId}
          currency={currency}
          timezone={timezone}
          title="Standalone payment"
          description={`Received from ${guestName} against their account at this property rather than against one stay. It joins their payment pool and settles their oldest unpaid item first, exactly as a payment taken at the desk does.`}
          referenceLabel="What this payment is for"
          referenceRequired
          referencePlaceholder="e.g. Settling the Aug bar tab — POS slip 8821"
          referenceHelp="Required. Recorded as the payment's reference and shown on the guest's statement, so an untied payment can still be explained later."
          onDone={onDone}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

function ModeButton({
  selected,
  onClick,
  label,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onClick}
      className={`rounded-full px-4 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
        selected
          ? 'bg-primary text-white'
          : 'border border-sand-border bg-white/70 text-charcoal hover:bg-sand'
      }`}
    >
      {label}
    </button>
  );
}
