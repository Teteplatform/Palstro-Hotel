import { useState } from 'react';
import { NumberField, TextArea, TextField, Toggle } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { humanizeError } from '../../../lib/errors';
import { createSupplier, updateSupplier } from '../../../lib/suppliers';
import type { Supplier, SupplierWrite } from '../../../types/purchasing';

// ADD OR EDIT A SUPPLIER (046 §1).
//
// ---------------------------------------------------------------------------
// WHY THE TAX AND BANK FIELDS ARE ON THIS FORM TODAY
// ---------------------------------------------------------------------------
// Nothing in this shipment computes with any of them. They are here because the
// table is empty NOW: adding a column to an empty table is free, and adding one
// to a live supplier list is a backfill conversation with a hotel, supplier by
// supplier, months after the person who knew the answers stopped picking up.
// Paying suppliers is the next shipment and will need every one of them.
//
// THE BANK DETAILS ARE FIELDS RATHER THAN A LINE IN THE NOTE, which is where
// they end up otherwise — unsearchable, un-copyable, and formatted five
// different ways by five different people.
//
// ---------------------------------------------------------------------------
// THE FORM AUTHORS NO RULE (rule 21)
// ---------------------------------------------------------------------------
// A duplicate name, a duplicate code and a withholding rate outside 0-100 are
// all refused by the database, and what the person reads is the database's
// sentence. The only validation here is the one the browser does for free.

interface SupplierFormProps {
  tenantId: string;
  // NULL creates. A supplier row edits.
  supplier: Supplier | null;
  onDone: (supplier: Supplier) => Promise<void> | void;
  onCancel: () => void;
}

const BLANK: SupplierWrite = {
  name: '',
  code: '',
  contact_name: '',
  phone: '',
  email: '',
  address: '',
  tax_id: '',
  withholding_tax_rate: null,
  bank_name: '',
  bank_account_name: '',
  bank_account_number: '',
  note: '',
  is_active: true,
};

export function SupplierForm({
  tenantId,
  supplier,
  onDone,
  onCancel,
}: SupplierFormProps) {
  const toast = useToast();
  const [form, setForm] = useState<SupplierWrite>(
    supplier
      ? {
          name: supplier.name,
          code: supplier.code ?? '',
          contact_name: supplier.contact_name ?? '',
          phone: supplier.phone ?? '',
          email: supplier.email ?? '',
          address: supplier.address ?? '',
          tax_id: supplier.tax_id ?? '',
          withholding_tax_rate: supplier.withholding_tax_rate,
          bank_name: supplier.bank_name ?? '',
          bank_account_name: supplier.bank_account_name ?? '',
          bank_account_number: supplier.bank_account_number ?? '',
          note: supplier.note ?? '',
          is_active: supplier.is_active,
        }
      : BLANK,
  );
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const set = <K extends keyof SupplierWrite>(key: K, value: SupplierWrite[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFormError(null);
    try {
      const saved = supplier
        ? await updateSupplier(supplier.id, form)
        : await createSupplier(tenantId, form);
      toast.success(supplier ? 'Supplier updated.' : 'Supplier added.');
      await onDone(saved);
    } catch (e) {
      // The server's own words, with its hint (rules 11, 21).
      setFormError(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-4 rounded-2xl border border-sand-border bg-white/60 p-4"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField
          label="Name"
          value={form.name}
          onChange={(v) => set('name', v)}
          required
          placeholder="Bonny Fresh Foods"
        />
        <TextField
          label="Short code"
          value={form.code ?? ''}
          onChange={(v) => set('code', v)}
          // EARNS ITS PLACE (rule 25): the label says "short code" and gives no
          // clue what it is for. Somebody holding a delivery note has the code.
          helpText="Optional. Shown beside the name when you search for them."
          placeholder="BFF"
        />
        <TextField
          label="Contact"
          value={form.contact_name ?? ''}
          onChange={(v) => set('contact_name', v)}
          placeholder="Who to ask for"
        />
        <TextField
          label="Phone"
          type="tel"
          value={form.phone ?? ''}
          onChange={(v) => set('phone', v)}
        />
        <TextField
          label="Email"
          type="email"
          value={form.email ?? ''}
          onChange={(v) => set('email', v)}
        />
        <TextField
          label="Address"
          value={form.address ?? ''}
          onChange={(v) => set('address', v)}
        />
      </div>

      {/* THE TWO GROUPS BELOW CARRY ONE LINE EACH, and that line is not
          teaching (rule 25) — it is the answer to "why am I being asked for
          this, when nothing on this screen uses it?", which is a question the
          form itself raises. */}
      <fieldset className="space-y-3 rounded-xl border border-sand-border p-3">
        <legend className="px-1 text-xs font-semibold tracking-wide text-charcoal-muted uppercase">
          Tax
        </legend>
        <p className="text-xs text-charcoal-muted">
          Collected for supplier payments, which are being built next. Nothing
          here is calculated with yet.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            label="TIN"
            value={form.tax_id ?? ''}
            onChange={(v) => set('tax_id', v)}
            placeholder="12345678-0001"
          />
          <NumberField
            label="Withholding tax rate"
            value={form.withholding_tax_rate}
            onChange={(v) => set('withholding_tax_rate', v)}
            min={0}
            max={100}
            step="any"
            helpText="Per cent. Goods and services withhold at different rates."
          />
        </div>
      </fieldset>

      <fieldset className="space-y-3 rounded-xl border border-sand-border p-3">
        <legend className="px-1 text-xs font-semibold tracking-wide text-charcoal-muted uppercase">
          Bank
        </legend>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField
            label="Bank"
            value={form.bank_name ?? ''}
            onChange={(v) => set('bank_name', v)}
          />
          <TextField
            label="Account name"
            value={form.bank_account_name ?? ''}
            onChange={(v) => set('bank_account_name', v)}
          />
          <TextField
            label="Account number"
            value={form.bank_account_number ?? ''}
            onChange={(v) => set('bank_account_number', v)}
          />
        </div>
      </fieldset>

      <TextArea
        label="Note"
        value={form.note ?? ''}
        onChange={(v) => set('note', v)}
        rows={2}
      />

      <Toggle
        label="In use"
        value={form.is_active}
        onChange={(v) => set('is_active', v)}
        helpText="Switch off a supplier you no longer buy from. Their orders stay on the record."
      />

      {formError ? (
        <p className="rounded-lg bg-primary/10 px-3 py-2 text-sm text-charcoal">
          {formError}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-full px-5 py-2.5 text-sm font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || form.name.trim().length === 0}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? 'Saving…' : supplier ? 'Save supplier' : 'Add supplier'}
        </button>
      </div>
    </form>
  );
}
