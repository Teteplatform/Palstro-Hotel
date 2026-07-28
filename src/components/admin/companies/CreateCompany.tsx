import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField } from '../../ui/form';
import { PlusIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import { createCompany } from '../../../lib/companies';
import type { Company } from '../../../types/company';

// Create a corporate account. Only the name is required; contacts and the
// negotiated rates are filled in by opening the created company. Admin-gated at
// the DB (016 policies); the caller only renders this for an admin context, but
// the policy is the real guard (rule 19).

interface CreateCompanyProps {
  tenantId: string;
  onCreated: (row: Company) => void;
}

export function CreateCompany({ tenantId, onCreated }: CreateCompanyProps) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [contactName, setContactName] = useState('');
  const [contactPhone, setContactPhone] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);

  function reset() {
    setName('');
    setContactName('');
    setContactPhone('');
    setError(undefined);
  }

  async function handleCreate() {
    if (!name.trim()) {
      setError('A company name is required.');
      return;
    }
    setSaving(true);
    try {
      const row = await createCompany(tenantId, {
        name: name.trim(),
        contact_name: contactName.trim() || null,
        contact_phone: contactPhone.trim() || null,
      });
      onCreated(row);
      toast.success('Company added. Open it to set negotiated rates.');
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
        Add company
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-4">
      <h2 className="mb-3 text-base font-semibold text-charcoal">New company</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Company name"
          required
          value={name}
          onChange={setName}
          error={error}
          placeholder="e.g. NLNG"
          disabled={saving}
        />
        <TextField
          label="Contact name"
          value={contactName}
          onChange={setContactName}
          placeholder="Optional"
          disabled={saving}
        />
        <TextField
          label="Contact phone"
          value={contactPhone}
          onChange={setContactPhone}
          placeholder="Optional"
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
          {saving ? 'Adding…' : 'Add company'}
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
