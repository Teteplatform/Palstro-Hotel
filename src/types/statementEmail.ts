// One recorded attempt to email a guest their statement (migration 030).
//
// EVIDENCE, NOT STATE. The row says who sent which document to what address and
// what the provider answered; it carries no money column, by design (rule 6) —
// a balance snapshotted at send time would drift from folio_totals the moment
// the next payment landed, and nothing could repair it.
export type StatementEmailStatus = 'sending' | 'sent' | 'failed';

export interface StatementEmail {
  id: string;
  tenant_id: string;
  property_id: string;
  subject_kind: 'stay' | 'standalone';
  booking_id: string | null;
  guest_id: string | null;
  document_reference: string;
  to_email: string;
  provider: string;
  provider_message_id: string | null;
  status: StatementEmailStatus;
  error_message: string | null;
  // The PROPERTY's operating day of the send (rules 8, 12) — what every surface
  // displays and orders by. created_at is audit metadata beside it.
  business_date: string;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}
