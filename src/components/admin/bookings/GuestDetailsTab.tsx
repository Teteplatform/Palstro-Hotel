import { useState } from 'react';
import { DetailTable, DetailRow } from '../../ui/DetailTable';
import { controlClasses } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { useDirtyForm } from '../../../hooks/useDirtyForm';
import { humanizeError } from '../../../lib/errors';
import { MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { GUEST_ID_TYPE_OPTIONS, updateGuest } from '../../../lib/guests';
import type { BookingDetail } from '../../../types/booking';

// The Guest Details tab (build A §2).
//
// EDITING GOES THROUGH THE PATH THAT ALREADY EXISTS, AND NOTHING WAS INVENTED.
// There is no update_guest RPC — create_guest is the only guest RPC in the schema
// (018). The existing update path is the `guests_member_update` RLS policy from
// 014, written for exactly this ("direct admin edits are for corrections"), and it
// is ADMIN-ONLY. So:
//   * an owner/manager sees Edit and can save;
//   * a front-desk user sees the details read-only, and is TOLD why, rather than
//     being offered a Save that the database would refuse.
// Widening correction rights to the front desk needs a staff-gated update_guest
// RPC (the mirror of create_guest). That is a schema change and is not made here.
//
// The ID fields are grouped into their own table because they are a different
// KIND of fact: government identity, recorded because Nigerian hotels must, and
// the group heading is what tells a user at a glance that this is the sensitive
// section rather than more contact details.

interface GuestDetailsTabProps {
  guest: NonNullable<BookingDetail['guest']> | null;
  tenantId: string;
  // Whether this user may save a correction. The RLS policy is the real guard —
  // this only decides whether to OFFER the action (rule 19's pattern).
  canEdit: boolean;
  onSaved: () => Promise<void> | void;
}

interface GuestForm {
  first_name: string;
  last_name: string;
  middle_name: string;
  phone: string;
  email: string;
  nationality: string;
  id_type: string;
  id_number: string;
  id_expiry: string;
  // Free-text stay preferences (027). Editable here as well as on the guest's
  // own page — both write through the same admin-gated correction path.
  preferences: string;
}

function toForm(guest: NonNullable<BookingDetail['guest']>): GuestForm {
  return {
    first_name: guest.first_name ?? '',
    last_name: guest.last_name ?? '',
    middle_name: guest.middle_name ?? '',
    phone: guest.phone ?? '',
    email: guest.email ?? '',
    nationality: guest.nationality ?? '',
    id_type: guest.id_type ?? '',
    id_number: guest.id_number ?? '',
    id_expiry: guest.id_expiry ?? '',
    preferences: guest.preferences ?? '',
  };
}

export function GuestDetailsTab({
  guest,
  tenantId,
  canEdit,
  onSaved,
}: GuestDetailsTabProps) {
  const toast = useToast();
  const { markDirty, markClean } = useDirtyForm();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<GuestForm | null>(null);
  const [saving, setSaving] = useState(false);

  if (!guest) {
    return (
      <p className="rounded-2xl border border-sand-border bg-white/60 p-4 text-sm text-charcoal">
        This booking has no guest attached, which should not be possible — every
        booking is created against a guest. Please contact support.
      </p>
    );
  }

  const values = form ?? toForm(guest);

  function set(patch: Partial<GuestForm>) {
    setForm({ ...values, ...patch });
    markDirty();
  }

  function startEditing() {
    setForm(toForm(guest as NonNullable<BookingDetail['guest']>));
    setEditing(true);
  }

  function cancelEditing() {
    setForm(null);
    setEditing(false);
    markClean();
  }

  const canSave =
    values.first_name.trim().length > 0 && values.last_name.trim().length > 0;

  async function handleSave() {
    if (!guest || saving) return;
    if (!canSave) {
      toast.error('A guest needs a first and last name.');
      return;
    }
    setSaving(true);
    try {
      await updateGuest(guest.id, tenantId, values);
      // full_name is GENERATED in the database from the structured name, so the
      // refreshed booking carries the recomputed display name — nothing here
      // assembles it, and it cannot drift from its parts.
      toast.success('Guest details saved.');
      markClean();
      setEditing(false);
      setForm(null);
      await onSaved();
    } catch (e) {
      // Rule 11: surfaced, never swallowed. A front-desk user who somehow reaches
      // this path gets the RLS refusal in plain language from humanizeError.
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-bold tracking-tight text-charcoal">
          Guest Details
        </h2>
        {canEdit ? (
          editing ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={cancelEditing}
                disabled={saving}
                className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void handleSave()}
                disabled={saving || !canSave}
                className="rounded-full bg-accent px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save changes'}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startEditing}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
            >
              Edit details
            </button>
          )
        ) : (
          <span className="text-xs text-charcoal-muted">
            Read-only — an owner or manager can correct these details.
          </span>
        )}
      </header>

      <DetailTable caption="Name & contact">
        <DetailRow label="First name">
          <EditableCell
            editing={editing}
            label="First name"
            value={values.first_name}
            onChange={(v) => set({ first_name: v })}
            disabled={saving}
            required
          />
        </DetailRow>
        <DetailRow label="Middle name">
          <EditableCell
            editing={editing}
            label="Middle name"
            value={values.middle_name}
            onChange={(v) => set({ middle_name: v })}
            disabled={saving}
          />
        </DetailRow>
        <DetailRow label="Last name">
          <EditableCell
            editing={editing}
            label="Last name"
            value={values.last_name}
            onChange={(v) => set({ last_name: v })}
            disabled={saving}
            required
          />
        </DetailRow>
        <DetailRow label="Phone">
          <EditableCell
            editing={editing}
            label="Phone"
            type="tel"
            value={values.phone}
            onChange={(v) => set({ phone: v })}
            disabled={saving}
          />
        </DetailRow>
        <DetailRow label="Email">
          <EditableCell
            editing={editing}
            label="Email"
            type="email"
            value={values.email}
            onChange={(v) => set({ email: v })}
            disabled={saving}
          />
        </DetailRow>
        <DetailRow label="Nationality">
          <EditableCell
            editing={editing}
            label="Nationality"
            value={values.nationality}
            onChange={(v) => set({ nationality: v })}
            disabled={saving}
          />
        </DetailRow>
      </DetailTable>

      {/* Stay preferences (2.txt §1). Its own section because it is a different
          kind of fact from contact details — something the hotel LEARNS about a
          guest over several stays, free text, read by no logic. The same field
          is editable on the guest's own page; both save through updateGuest's
          admin-only path. */}
      <DetailTable caption="Stay preferences">
        <DetailRow label="Preferences">
          {editing ? (
            <textarea
              value={values.preferences}
              onChange={(e) => set({ preferences: e.target.value })}
              disabled={saving}
              rows={3}
              aria-label="Stay preferences"
              placeholder="Top floor, quiet room, early breakfast…"
              className={controlClasses}
            />
          ) : (
            <span className="whitespace-pre-wrap">
              {guest.preferences?.trim() ? guest.preferences : MISSING_VALUE}
            </span>
          )}
        </DetailRow>
      </DetailTable>

      {/* The sensitive group, visibly its own section. */}
      <DetailTable caption="Identification">
        <DetailRow label="ID type">
          {editing ? (
            <select
              value={values.id_type}
              onChange={(e) => set({ id_type: e.target.value })}
              disabled={saving}
              aria-label="ID type"
              className={controlClasses}
            >
              <option value="">Not recorded</option>
              {GUEST_ID_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <span>{idTypeLabel(guest.id_type)}</span>
          )}
        </DetailRow>
        <DetailRow label="ID number">
          <EditableCell
            editing={editing}
            label="ID number"
            value={values.id_number}
            onChange={(v) => set({ id_number: v })}
            disabled={saving}
          />
        </DetailRow>
        <DetailRow label="ID expiry">
          {editing ? (
            <input
              type="date"
              value={values.id_expiry}
              onChange={(e) => set({ id_expiry: e.target.value })}
              disabled={saving}
              aria-label="ID expiry"
              className={controlClasses}
            />
          ) : (
            <span>
              {guest.id_expiry ? formatDisplayDate(guest.id_expiry) : MISSING_VALUE}
            </span>
          )}
        </DetailRow>
      </DetailTable>

      <p className="text-xs text-charcoal-muted">
        Identity details are recorded for the hotel's legal obligations. They are
        never shown on the public site, and every change is logged against the
        person who made it.
      </p>
    </div>
  );
}

// A value cell that becomes an input in edit mode. The row's own <th> is the
// visible label, so the input carries it as an aria-label rather than repeating
// it on screen. A blank value reads as the shared dash, never as empty space.
function EditableCell({
  editing,
  label,
  value,
  onChange,
  disabled,
  required,
  type = 'text',
}: {
  editing: boolean;
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  required?: boolean;
  type?: 'text' | 'tel' | 'email';
}) {
  if (!editing) {
    return <span>{value.trim().length > 0 ? value : MISSING_VALUE}</span>;
  }
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      required={required}
      aria-label={label}
      aria-invalid={required && value.trim().length === 0 ? true : undefined}
      className={controlClasses}
    />
  );
}

// The stored id_type is a machine value ('national_id'); staff read the label.
// An unrecognised value is shown as-is rather than hidden — data the app does not
// recognise still belongs to the hotel.
function idTypeLabel(value: string | null): string {
  if (!value) return MISSING_VALUE;
  return GUEST_ID_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
