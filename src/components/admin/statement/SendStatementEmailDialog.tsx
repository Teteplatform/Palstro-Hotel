import { useEffect, useRef, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField } from '../../ui/form';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { useTenantContext } from '../../../hooks/useTenantContext';
import { describeError, humanizeError } from '../../../lib/errors';
import { formatDisplayDate } from '../../../lib/date';
import { newIdempotencyKey } from '../../../lib/folio';
import { updateGuestEmail } from '../../../lib/guests';
import {
  fetchLastStatementEmail,
  sendStatementEmail,
  StatementEmailError,
} from '../../../lib/statementEmail';
import { resolveStatementGuestId } from '../../../lib/statementLoad';
import type { StatementData } from '../../../lib/statement';
import type { StatementTarget } from '../../../lib/statementLoad';
import type { StatementEmail } from '../../../types/statementEmail';
import type { Property } from '../../../types/tenant';

// ===========================================================================
// EMAILING THE STATEMENT — THE CONFIRM STEP
// ===========================================================================
//
// THE DESK CONFIRMS THE ADDRESS EVERY TIME, and that is the whole reason this is
// a dialog rather than a menu item that fires. A guest checking in at a busy
// desk gives an address that is written down wrong, or is their company's, or
// was right two years ago. Sending a bill to the wrong inbox is not a retryable
// mistake — the document is gone, to somebody, with a name, a stay and a
// balance on it. So the address on file is SHOWN, editable, and sent only when a
// person has looked at it.
//
// IT IS PRE-FILLED, AND THAT DOES NOT CONTRADICT RULE 10. That rule forbids
// pre-filling a payment AMOUNT, because a pre-filled figure produces a
// full-payment nobody verified. An address is not a figure: there is nothing to
// verify against, retyping it invites a typo, and the guest's record is the best
// available answer. What matters is that it is visible and correctable, which is
// what this does.
//
// A GUEST WITH NO EMAIL ON FILE is prompted for one rather than blocked, and an
// administrator is offered the chance to save it back to the guest record so the
// next send does not ask again. The save is a SEPARATE, non-fatal step: the
// statement going out is the thing that matters, and a failed save must not read
// as a failed send.
//
// EVERY OUTCOME IS SAID OUT LOUD (rule 11). Sent, already sent, still sending,
// or failed with the server's own words — never a spinner that quietly stops.

interface SendStatementEmailDialogProps {
  statement: StatementData;
  target: StatementTarget;
  property: Property;
  onClose: () => void;
}

// Same shape the endpoint, the RPC and the CHECK constraint all use. Four
// implementations of one rule would be four rules; this is deliberately the
// weakest useful check — no whitespace, one @, a dot in the domain — because
// anything cleverer rejects real addresses.
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function SendStatementEmailDialog({
  statement,
  target,
  property,
  onClose,
}: SendStatementEmailDialogProps) {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);
  const { isAdmin } = useTenantContext();

  const onFile = statement.guest.email ?? '';
  const [email, setEmail] = useState(onFile);
  const [saveToGuest, setSaveToGuest] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastSend, setLastSend] = useState<StatementEmail | null>(null);

  // The guest record is edited through the admin-gated `guests_member_update`
  // policy (014), so a front-desk user is not offered a save they cannot make —
  // the database would refuse it. They can still correct the address for THIS
  // send, which is what the desk actually needs at the counter.
  const changed = email.trim() !== onFile.trim();
  const canSaveToGuest = isAdmin && changed && EMAIL_PATTERN.test(email.trim());

  // Has this document already gone out, and where to? A second copy is often
  // exactly what is wanted ("send it to my company too"), so this informs rather
  // than blocks.
  //
  // The effect depends on PRIMITIVES, not on the `target` object: every caller
  // builds that literal inline, so a parent re-render remints it and an object
  // dependency would re-read on every keystroke in the address field.
  const kind = target.kind;
  const subjectId = target.kind === 'stay' ? target.bookingId : target.guestId;
  const tenantId = property.tenant_id;
  const propertyId = property.id;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const row = await fetchLastStatementEmail(
          kind === 'stay'
            ? { kind: 'stay', bookingId: subjectId }
            : { kind: 'standalone', guestId: subjectId },
          tenantId,
          propertyId,
        );
        if (!cancelled) setLastSend(row);
      } catch {
        // Not worth a red panel: it is context, not the action. The send itself
        // reports its own outcome.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kind, subjectId, tenantId, propertyId]);

  const trimmed = email.trim();
  const valid = EMAIL_PATTERN.test(trimmed);

  // THE IDEMPOTENCY KEY IS PER INTENT, NOT PER PRESS — and the distinction is
  // the whole reason the send is claimed in the database before it is made.
  //
  // "Send this statement to THIS address" is one intent. If the first attempt
  // comes back as a dropped connection, the desk presses Send again — and that
  // second press must not mail the guest a second copy just because the first
  // response never arrived. Reusing the key means the endpoint recognises the
  // claim, sends nothing, and reports what became of the original attempt.
  //
  // A NEW intent gets a new key: a different address, or a fresh attempt after a
  // send that definitively failed (below). A ref, not state, because minting a
  // key must not re-render the dialog mid-send.
  const intent = useRef<{ email: string; key: string } | null>(null);
  function idempotencyKeyFor(address: string): string {
    if (!intent.current || intent.current.email !== address) {
      intent.current = { email: address, key: newIdempotencyKey() };
    }
    return intent.current.key;
  }

  async function handleSend() {
    if (sending || !valid) return;
    setSending(true);
    setError(null);
    try {
      const outcome = await sendStatementEmail({
        propertyId: property.id,
        target,
        statement,
        toEmail: trimmed,
        idempotencyKey: idempotencyKeyFor(trimmed),
      });

      // The address is saved only AFTER the statement is away, and its failure
      // is reported separately — a guest record that would not update must never
      // make a delivered statement look undelivered.
      if (saveToGuest && canSaveToGuest) {
        await saveGuestEmail();
      }

      // "Sent to x", "already sent to x", or "already being sent" — the endpoint
      // words each outcome, and each of the three means the guest is getting
      // their statement.
      toast.success(outcome.message);
      onClose();
    } catch (e) {
      // The server's own words (rule 11): "The email provider refused the
      // message: …", "You do not have access to this property", "This stay has
      // no folio…". Each says what to do differently.
      const message =
        e instanceof StatementEmailError ? e.message : describeError(e);
      // A send that DEFINITIVELY failed ends its intent, so the next press is a
      // fresh attempt under a new key rather than a request the endpoint can
      // only recognise as the dead claim and refuse again. Note which failures
      // do NOT clear it: a dropped connection or an unreadable response, where
      // nobody knows whether the mail went — those are exactly the cases the key
      // must survive, so a retry cannot produce a second copy.
      const status = e instanceof StatementEmailError ? e.status : undefined;
      if (status === 'failed' || status === 'previously_failed') {
        intent.current = null;
      }
      setError(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
  }

  async function saveGuestEmail() {
    try {
      const guestId = await resolveStatementGuestId(
        target,
        property.tenant_id,
        property.id,
      );
      if (!guestId) {
        toast.error(
          'The statement was sent, but the guest record could not be identified, so the address was not saved.',
        );
        return;
      }
      // ONE column (lib/guests' updateGuestEmail), so a corrected address can
      // never blank a name, a phone number or an ID document.
      await updateGuestEmail(guestId, property.tenant_id, trimmed);
      toast.success('The address was saved to the guest record.');
    } catch (e) {
      toast.error(
        `The statement was sent, but the guest record could not be updated: ${humanizeError(e)}`,
      );
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-charcoal/40 p-4 sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Email this statement to the guest"
        className="w-full max-w-md rounded-2xl bg-cream shadow-xl"
      >
        <header className="flex items-center justify-between gap-3 border-b border-sand-border px-5 py-4">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            Email statement
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            aria-label="Close"
            className="rounded-lg p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-4 px-5 py-5">
          {/* What is about to be sent, named the way the guest will see it. */}
          <div className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal">
            <p className="font-semibold">
              {statement.title} {statement.reference}
            </p>
            <p className="text-xs text-charcoal-muted">
              {statement.guest.name} · {statement.property.name}
            </p>
          </div>

          <TextField
            label="Send to"
            value={email}
            onChange={(value) => {
              setEmail(value);
              setError(null);
            }}
            type="email"
            inputMode="email"
            autoComplete="off"
            disabled={sending}
            required
            error={
              email.length > 0 && !valid
                ? 'That does not look like an email address.'
                : undefined
            }
            helpText={
              onFile
                ? 'The address on the guest’s record. Correct it here if it is wrong — this send goes to whatever is in this box.'
                : 'This guest has no email address on file. Ask them for one; it is used for this send only unless you save it below.'
            }
          />

          {canSaveToGuest ? (
            <label className="flex items-start gap-2 text-sm text-charcoal">
              <input
                type="checkbox"
                checked={saveToGuest}
                onChange={(e) => setSaveToGuest(e.target.checked)}
                disabled={sending}
                className="mt-0.5 h-4 w-4 rounded border-sand-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
              />
              <span>
                Also save this address to the guest record
                <span className="block text-xs text-charcoal-muted">
                  So the next statement, confirmation or receipt goes to the right
                  place without anyone retyping it.
                </span>
              </span>
            </label>
          ) : changed && !isAdmin ? (
            <p className="text-xs text-charcoal-muted">
              This send will use the address above. Only an owner or manager can
              change the address held on the guest record.
            </p>
          ) : null}

          {lastSend ? (
            <p className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-xs text-charcoal-muted">
              Last sent to <span className="font-medium text-charcoal">{lastSend.to_email}</span>{' '}
              on {formatDisplayDate(lastSend.business_date)}. Sending again is fine
              — the guest simply receives another copy.
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="rounded-lg border border-primary/40 bg-white/70 px-3 py-2 text-sm text-charcoal"
            >
              {error}
            </p>
          ) : null}

          <p className="text-[11px] text-charcoal-muted">
            The statement is attached as a PDF — the same document you can print
            or download, generated fresh from this folio when you press Send.
          </p>
        </div>

        <footer className="flex items-center justify-end gap-2 border-t border-sand-border px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={sending}
            className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSend()}
            disabled={sending || !valid}
            className="rounded-full bg-accent px-6 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {sending ? 'Sending…' : 'Send statement'}
          </button>
        </footer>
      </div>
    </div>
  );
}

