import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField, CurrencyField } from '../../ui/form';
import { PlusIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import { createRoomType } from '../../../lib/roomTypes';
import type { RoomType } from '../../../types/room';

// Create a new room type. Only name and rack rate are required (base_rate is NOT
// NULL in 002; everything else takes a schema default and is filled in by editing
// the created card). The new type is created as a DRAFT (is_published defaults
// false) so it never appears on the guest site before the owner has finished it.
//
// display_order is appended (= current total) so the new type lands at the END of
// the list with a distinct order value, keeping up/down reordering unambiguous.

interface CreateRoomTypeProps {
  tenantId: string;
  propertyId: string;
  currency: string;
  nextDisplayOrder: number;
  onCreated: (row: RoomType) => void;
}

export function CreateRoomType({
  tenantId,
  propertyId,
  currency,
  nextDisplayOrder,
  onCreated,
}: CreateRoomTypeProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [rackRate, setRackRate] = useState<number | null>(null);
  const [errors, setErrors] = useState<{ name?: string; base_rate?: string }>({});
  const [saving, setSaving] = useState(false);

  function reset() {
    setName('');
    setRackRate(null);
    setErrors({});
  }

  function validate(): boolean {
    const found: { name?: string; base_rate?: string } = {};
    if (!name.trim()) found.name = 'A name is required.';
    if (rackRate === null) found.base_rate = 'Enter a rack rate.';
    else if (rackRate < 0) found.base_rate = 'Rate cannot be negative.';
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function handleCreate() {
    if (!validate()) return;
    setSaving(true);
    try {
      const row = await createRoomType(tenantId, propertyId, {
        name: name.trim(),
        base_rate: rackRate as number,
        display_order: nextDisplayOrder,
      });
      onCreated(row);
      toast.success('Room type created. Open it to add photos and details.');
      reset();
      setOpen(false);
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
      >
        <PlusIcon className="h-4 w-4" />
        Add room type
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="mb-3 text-base font-semibold text-charcoal">
        New room type
      </h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Name"
          required
          value={name}
          onChange={setName}
          error={errors.name}
          placeholder="e.g. Deluxe Double"
          disabled={saving}
        />
        <CurrencyField
          label="Rack rate"
          required
          currency={currency}
          value={rackRate}
          onChange={setRackRate}
          error={errors.base_rate}
          helpText="The standard nightly price; you can add weekend and seasonal rates after."
          disabled={saving}
        />
      </div>
      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={saving}
          className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          {saving ? 'Creating…' : 'Create room type'}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={saving}
          className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
