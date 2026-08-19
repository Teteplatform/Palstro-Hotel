import { useState } from 'react';
import {
  VOID_ABOUT,
  VOID_ABOUT_TITLE,
} from '../../../lib/folioLabels';
import { TextArea } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import {
  folioErrorMessage,
  newIdempotencyKey,
  voidCharge,
  voidPayment,
} from '../../../lib/folio';
import { FolioActionCard } from './FolioActionCard';

// Void a charge or a payment (brief §5).
//
// VOIDED, NEVER DELETED. The line stays on the bill, struck through and marked,
// with its reason, its time and the name of whoever reversed it. A mistaken
// ₦150,000 charge that simply vanished would be indistinguishable from a charge
// that was never posted — which is exactly the cover a dishonest posting needs.
//
// A voided row leaves the totals because folio_totals filters it out with the
// NULL-safe `is_voided is not true` (rule 5); nothing is decremented, because
// nothing is cached (rules 6, 7).
//
// THE CONFIRMATION IS THE POINT, NOT FRICTION FOR ITS OWN SAKE. Voiding a payment
// says money that was recorded as received was not received; voiding a charge says
// a sale did not happen. Both are significant enough to be a deliberate act with a
// stated reason, so this is a two-step action with a mandatory reason — which the
// RPC also enforces, so a blank one is rejected by the database too.

interface VoidFormProps {
  // For the ⓘ's link into this property's copy of the staff guide.
  propertySlug: string;
  target: { kind: 'charge' | 'payment'; id: string; summary: string };
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function VoidForm({
  target,
  propertySlug,
  onDone,
  onCancel,
}: VoidFormProps) {
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const isCharge = target.kind === 'charge';
  const canSubmit = reason.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      // void_charge / void_payment are idempotent BY STATE — voiding an
      // already-voided row returns it unchanged — so a retry is safe even with a
      // different key. The key is passed for interface consistency (rule 2).
      const key = newIdempotencyKey();
      if (isCharge) {
        await voidCharge(target.id, reason.trim(), key);
      } else {
        await voidPayment(target.id, reason.trim(), key);
      }
      toast.success(isCharge ? 'Charge voided.' : 'Payment voided.');
      await onDone();
    } catch (e) {
      toast.error(folioErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={isCharge ? 'Void this charge' : 'Void this payment'}
      subject={target.summary}
      effect={
        isCharge
          ? 'It stays on the bill, marked as voided, and drops out of the totals.'
          : 'It stays on the bill, marked as voided, and stops counting towards what has been paid.'
      }
      about={{
        title: VOID_ABOUT_TITLE,
        paragraphs: VOID_ABOUT,
        guideAnchor: 'void-or-reverse',
        guideLabel: 'Void or Reverse?',
      }}
      propertySlug={propertySlug}
      submitLabel={isCharge ? 'Void charge' : 'Void payment'}
      submittingLabel="Voiding…"
      submitting={submitting}
      canSubmit={canSubmit}
      destructive
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      <TextArea
        label="Reason for the void"
        required
        value={reason}
        onChange={setReason}
        rows={2}
        disabled={submitting}
        placeholder={
          isCharge
            ? 'e.g. posted to the wrong room, duplicate of ticket 218'
            : 'e.g. transfer never cleared, keyed against the wrong folio'
        }
        helpText="Recorded against you on the row, permanently."
      />
    </FolioActionCard>
  );
}
