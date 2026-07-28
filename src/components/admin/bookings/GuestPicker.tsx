import { useEffect, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField, DateField, Select } from '../../ui/form';
import { humanizeError } from '../../../lib/errors';
import {
  searchGuests,
  createGuest,
  GUEST_SEARCH_LIMIT,
  GUEST_ID_TYPE_OPTIONS,
} from '../../../lib/guests';
import type { Guest } from '../../../types/guest';
import type { NewGuestDraft } from '../../../hooks/useBookingDraft';

// Attach a guest to a booking (build 6b §3): search existing guests by name or
// phone, or register a new one inline. New guests are created through the staff-
// gated create_guest RPC (016), so front desk — not just admins — can register a
// walk-in. Every write is awaited in try/catch and surfaced (rule 11); the
// search is bounded and flags when capped (rule 1), so it reads as a type-ahead,
// not a silently truncated roster.
//
// The selected guest (value) AND the inline new-guest fields (newGuest) are
// CONTROLLED by the caller, so they live in the session-scoped booking draft and
// survive navigating away and back. Only the transient search box + results stay
// local — they reload on their own and are not worth persisting.

interface GuestPickerProps {
  tenantId: string;
  value: Guest | null;
  onChange: (guest: Guest | null) => void;
  newGuest: NewGuestDraft;
  onNewGuestChange: (patch: Partial<NewGuestDraft>) => void;
  disabled?: boolean;
}

export function GuestPicker({
  tenantId,
  value,
  onChange,
  newGuest,
  onNewGuestChange,
  disabled,
}: GuestPickerProps) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Guest[]>([]);
  const [capped, setCapped] = useState(false);
  const [searching, setSearching] = useState(false);
  // Transient in-flight flag for the create call (not part of the draft).
  const [saving, setSaving] = useState(false);

  // The inline new-guest form fields come from the draft (controlled).
  const creating = newGuest.creating;
  const {
    firstName,
    lastName,
    middleName,
    phone: newPhone,
    email: newEmail,
    idType,
    idNumber,
    idExpiry,
  } = newGuest;

  // Debounced search: refetch shortly after the query settles. Skipped while a
  // guest is already chosen (the search box is hidden then).
  useEffect(() => {
    if (value) return;
    let cancelled = false;
    const handle = setTimeout(() => {
      (async () => {
        setSearching(true);
        try {
          const result = await searchGuests(tenantId, query);
          if (cancelled) return;
          setResults(result.rows);
          setCapped(result.capped);
        } catch (e) {
          if (cancelled) return;
          toast.error(humanizeError(e));
        } finally {
          if (!cancelled) setSearching(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, query, value]);

  async function handleCreate() {
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('A first and last name are required.');
      return;
    }
    setSaving(true);
    try {
      const guest = await createGuest(tenantId, {
        first_name: firstName.trim(),
        last_name: lastName.trim(),
        middle_name: middleName.trim() || null,
        phone: newPhone.trim() || null,
        email: newEmail.trim() || null,
        id_type: idType || null,
        id_number: idNumber.trim() || null,
        id_expiry: idExpiry || null,
      });
      toast.success('Guest registered.');
      onChange(guest);
      // Reset the inline form in the draft now that the guest is attached.
      onNewGuestChange({
        creating: false,
        firstName: '',
        lastName: '',
        middleName: '',
        phone: '',
        email: '',
        idType: '',
        idNumber: '',
        idExpiry: '',
      });
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  // A guest is chosen — show it with a change affordance.
  if (value) {
    return (
      <div className="rounded-xl border border-sand-border bg-white/70 p-3">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-charcoal">
              {value.full_name}
            </p>
            <p className="truncate text-xs text-charcoal-muted">
              {value.phone || value.email || 'No contact on file'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={disabled}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Change
          </button>
        </div>
      </div>
    );
  }

  // Inline create form: structured name + contact, then a grouped Identification
  // block (018). Only first + last name are required; ID details are captured when
  // available (often at check-in). Every field is controlled by the session draft,
  // so a half-typed new guest survives navigating away and back.
  if (creating) {
    return (
      <div className="rounded-xl border border-sand-border bg-white/70 p-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="First name" required value={firstName} onChange={(v) => onNewGuestChange({ firstName: v })} disabled={saving} autoComplete="given-name" />
          <TextField label="Last name" required value={lastName} onChange={(v) => onNewGuestChange({ lastName: v })} disabled={saving} autoComplete="family-name" />
          <TextField label="Middle name" value={middleName} onChange={(v) => onNewGuestChange({ middleName: v })} disabled={saving} autoComplete="additional-name" />
          <TextField label="Phone" type="tel" inputMode="tel" value={newPhone} onChange={(v) => onNewGuestChange({ phone: v })} disabled={saving} autoComplete="tel" />
          <div className="sm:col-span-2">
            <TextField label="Email" type="email" inputMode="email" value={newEmail} onChange={(v) => onNewGuestChange({ email: v })} disabled={saving} autoComplete="email" />
          </div>
        </div>

        {/* Identification (grouped) — SENSITIVE; recorded because Nigerian hotels
            must, never shown on the guest-facing site. */}
        <fieldset className="mt-4 rounded-lg border border-sand-border bg-sand/20 p-3">
          <legend className="px-1 text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            Identification
          </legend>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="ID type"
              value={idType}
              onChange={(v) => onNewGuestChange({ idType: v })}
              options={GUEST_ID_TYPE_OPTIONS}
              placeholder="Select ID type…"
              disabled={saving}
            />
            <TextField label="ID number" value={idNumber} onChange={(v) => onNewGuestChange({ idNumber: v })} disabled={saving} />
            <DateField label="ID expiry" value={idExpiry} onChange={(v) => onNewGuestChange({ idExpiry: v })} disabled={saving} helpText="Leave blank if the ID has no expiry." />
          </div>
        </fieldset>

        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            {saving ? 'Registering…' : 'Register guest'}
          </button>
          <button
            type="button"
            onClick={() => onNewGuestChange({ creating: false })}
            disabled={saving}
            className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Search + results.
  return (
    <div>
      <div className="flex items-end gap-2">
        <label className="flex-1">
          <span className="mb-1 block text-sm font-medium text-charcoal">
            Guest
          </span>
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name or phone…"
            disabled={disabled}
            className="w-full rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          />
        </label>
        <button
          type="button"
          onClick={() => onNewGuestChange({ creating: true })}
          disabled={disabled}
          className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          New guest
        </button>
      </div>

      <div className="mt-2 max-h-52 overflow-y-auto rounded-xl border border-sand-border bg-white/60">
        {searching ? (
          <p className="px-3 py-4 text-sm text-charcoal-muted" aria-live="polite">
            Searching…
          </p>
        ) : results.length === 0 ? (
          <p className="px-3 py-4 text-sm text-charcoal-muted">
            No guests found. Use “New guest” to register one.
          </p>
        ) : (
          <ul className="divide-y divide-sand-border">
            {results.map((g) => (
              <li key={g.id}>
                <button
                  type="button"
                  onClick={() => onChange(g)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium text-charcoal">
                      {g.full_name}
                    </span>
                    <span className="block truncate text-xs text-charcoal-muted">
                      {g.phone || g.email || '—'}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      {capped ? (
        <p className="mt-1 text-xs text-charcoal-muted">
          Showing the first {GUEST_SEARCH_LIMIT}. Refine your search to narrow it.
        </p>
      ) : null}
    </div>
  );
}
