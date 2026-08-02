import { useState } from 'react';
import { CameraIcon } from '../../ui/icons';
import { controlClasses } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { MISSING_VALUE } from '../../../lib/format';
import { formatDisplayDate } from '../../../lib/date';
import { GUEST_ID_TYPE_OPTIONS, updateGuestPreferences } from '../../../lib/guests';
import type { Guest } from '../../../types/guest';

// THE GUEST HOME'S PROFILE HEADER (2.txt §2) — who this person is, in one band
// above the tabs.
//
// IT SITS OUTSIDE BOTH TABS on purpose: a printed statement must identify the
// guest it belongs to, and a header inside the Ledger tab would print only when
// that tab happened to be open.
//
// THE PREFERENCES BOX IS GONE, replaced by the small pill beside the name. A
// whole card for one free-text line pushed the money — which is what the front
// desk actually opened this page for — below the fold on a phone, and the field
// is empty for most guests. As a pill it costs nothing when there is nothing to
// say, reads as part of the person's identity when there is, and edits in place.
//
// AUTHORITY: preferences save through the SAME admin-only `guests_member_update`
// policy every other guest correction uses (014). A front-desk user sees the
// value and is told who can change it, rather than being offered a Save the
// database would refuse — rule 19's pattern, where the client's check is user
// experience and the policy is the guard.

interface GuestProfileHeaderProps {
  guest: Guest;
  tenantId: string;
  // Whether this user may save a preference. RLS is the real guard; this only
  // decides whether to OFFER the action.
  canEdit: boolean;
  onGuestChanged: () => Promise<void> | void;
}

export function GuestProfileHeader({
  guest,
  tenantId,
  canEdit,
  onGuestChanged,
}: GuestProfileHeaderProps) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [photoNote, setPhotoNote] = useState(false);

  const preference = guest.preferences?.trim() ?? '';

  function startEditing() {
    setDraft(guest.preferences ?? '');
    setEditing(true);
  }

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await updateGuestPreferences(guest.id, tenantId, draft);
      toast.success('Preference saved.');
      setEditing(false);
      await onGuestChanged();
    } catch (e) {
      // Rule 11: surfaced, never swallowed.
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <header className="mt-4 mb-5">
      {/* At 360px the avatar and the identity block stack side by side and the
          facts wrap beneath; nothing scrolls sideways. */}
      <div className="flex items-start gap-3 sm:gap-4">
        <Avatar
          guest={guest}
          onPhotoAffordance={() => setPhotoNote((v) => !v)}
          noteOpen={photoNote}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <h1 className="text-xl font-bold tracking-tight text-charcoal sm:text-2xl">
              {guest.full_name}
            </h1>

            {/* THE PREFERENCE PILL. It carries the preference itself when there
                is one, so the fact is visible at a glance rather than behind a
                click, and it is the edit control at the same time. */}
            {canEdit ? (
              <button
                type="button"
                onClick={startEditing}
                aria-expanded={editing}
                className="max-w-full truncate rounded-full border border-sand-border bg-white/70 px-3 py-1 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream print:hidden"
              >
                {preference ? `★ ${preference}` : '+ Add preference'}
              </button>
            ) : preference ? (
              <span className="max-w-full truncate rounded-full border border-sand-border bg-white/70 px-3 py-1 text-xs font-semibold text-charcoal">
                ★ {preference}
              </span>
            ) : null}
          </div>

          {/* The three identity facts. Each is hidden entirely when there is
              nothing to say — a row of dashes under a guest's name reads as a
              broken record rather than a sparse one. */}
          <dl className="mt-1.5 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-charcoal-muted">
            <HeaderFact label="Phone" value={guest.phone} />
            <HeaderFact label="Email" value={guest.email} />
            <HeaderFact
              label="ID"
              value={
                guest.id_number
                  ? `${idTypeLabel(guest.id_type)} · ${guest.id_number}${
                      guest.id_expiry
                        ? ` · expires ${formatDisplayDate(guest.id_expiry)}`
                        : ''
                    }`
                  : null
              }
            />
          </dl>

          {/* Printed preference: the pill above is print:hidden because it is a
              control, so the fact itself needs a printable home. */}
          {preference ? (
            <p className="mt-1 hidden text-sm text-charcoal print:block">
              Preference: {preference}
            </p>
          ) : null}
        </div>
      </div>

      {/* Inline preference editor. Below the header rather than in a dialog: it
          is one field, and a modal over a page the user is reading costs more
          attention than the edit is worth. */}
      {editing ? (
        <div className="mt-3 rounded-2xl border border-sand-border bg-white/70 p-4 print:hidden">
          <label
            htmlFor="guest-preference"
            className="text-sm font-semibold text-charcoal"
          >
            Stay preference
          </label>
          <textarea
            id="guest-preference"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            rows={2}
            placeholder="Top floor, quiet room, early breakfast…"
            className={`mt-2 ${controlClasses}`}
          />
          <p className="mt-1.5 text-xs text-charcoal-muted">
            Free text the hotel learns over several stays. Nothing reads it
            automatically — it is here so the next receptionist knows.
          </p>
          <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={saving}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className="rounded-full bg-accent px-5 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save preference'}
            </button>
          </div>
        </div>
      ) : null}

      {/* THE PHOTO AFFORDANCE'S HONEST NOTE — see Avatar below for why the
          upload is not wired. */}
      {photoNote ? (
        <p
          role="status"
          className="mt-3 rounded-xl border border-sand-border bg-sand/40 px-4 py-3 text-xs text-charcoal print:hidden"
        >
          <strong className="font-semibold">Profile photo — not yet enabled.</strong>{' '}
          The hotel's existing image storage is deliberately world-readable: it
          serves the public guest website, and its access policy publishes every
          row it holds. A guest's face must not go there. Photos will arrive with
          the guest portal, on private storage the guest sets themselves, which is
          the only place a photo of a person belongs.
        </p>
      ) : null}
    </header>
  );
}

// The avatar: initials today, a real photo later.
//
// THE UPLOAD IS DELIBERATELY NOT WIRED, and this is a decision rather than an
// omission. The obvious route — media_assets plus the property-media bucket — is
// the wrong one twice over: the bucket is PUBLIC by design (005) and
// media_assets carries an anon read policy so the guest website can resolve its
// own images (010), so a guest's photograph uploaded there would be readable by
// the entire internet. Its category CHECK constraint would also have to be
// widened, i.e. a migration that publishes guest imagery. Neither is "cheap",
// and both are the kind of privacy failure that is only discovered afterwards.
// So the affordance is here, visibly, and says what it is waiting for.
function Avatar({
  guest,
  onPhotoAffordance,
  noteOpen,
}: {
  guest: Guest;
  onPhotoAffordance: () => void;
  noteOpen: boolean;
}) {
  return (
    <div className="relative shrink-0">
      <div
        aria-hidden="true"
        className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/15 text-lg font-bold tracking-tight text-primary sm:h-16 sm:w-16 sm:text-xl"
      >
        {initials(guest)}
      </div>
      <button
        type="button"
        onClick={onPhotoAffordance}
        aria-expanded={noteOpen}
        aria-label="Profile photo — not yet enabled"
        title="Profile photo — not yet enabled"
        className="absolute -bottom-1 -right-1 inline-flex h-6 w-6 items-center justify-center rounded-full border border-sand-border bg-white text-charcoal-muted shadow-sm transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream print:hidden"
      >
        <CameraIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

// First + last initial, from the STRUCTURED name (018) rather than by splitting
// full_name — "Lanre-Oyewole" and a two-word first name both break a split, and
// the structured columns are the fact.
function initials(guest: Guest): string {
  const first = guest.first_name?.trim()?.[0] ?? '';
  const last = guest.last_name?.trim()?.[0] ?? '';
  const pair = `${first}${last}`.toUpperCase();
  // A guest whose structured name is somehow empty still gets a circle with
  // something in it, taken from the generated display name.
  return pair || guest.full_name.trim().slice(0, 1).toUpperCase() || '?';
}

// One header fact, hidden entirely when there is nothing to say.
function HeaderFact({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="text-xs uppercase tracking-wide">{label}</dt>
      <dd className="truncate text-charcoal">{value}</dd>
    </div>
  );
}

// The stored id_type is a machine value ('national_id'); staff read the label.
// An unrecognised value is shown as-is — data the app does not recognise still
// belongs to the hotel.
function idTypeLabel(value: string | null): string {
  if (!value) return MISSING_VALUE;
  return GUEST_ID_TYPE_OPTIONS.find((o) => o.value === value)?.label ?? value;
}
