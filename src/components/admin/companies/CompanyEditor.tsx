import { useCallback, useEffect, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField, TextArea, Toggle } from '../../ui/form';
import { ChevronDownIcon } from '../../ui/icons';
import { humanizeError } from '../../../lib/errors';
import { updateCompany, fetchCompanyRates } from '../../../lib/companies';
import type { Company, CompanyRate } from '../../../types/company';
import type { RoomType } from '../../../types/room';
import { CompanyRatesEditor } from './CompanyRatesEditor';
import { CompanyRatePreview } from './CompanyRatePreview';

// One company as a collapsible card: a summary row always visible, and an
// expandable body carrying (a) the editable company details, (b) the negotiated
// rates editor (one row per room type), and (c) the rate preview. Rates are
// loaded lazily, only when the card is expanded, so a page of companies does not
// fan out into a rates query per company on mount.
//
// Every write is awaited in try/catch and surfaced (rule 11); reads are scoped
// to the active tenant in the data layer (rule 19).

interface CompanyEditorProps {
  company: Company;
  tenantId: string;
  propertyId: string;
  currency: string;
  roomTypes: RoomType[];
  onUpdated: (row: Company) => void;
  onRequestDelete: (company: Company) => void;
  busyRow: boolean;
}

export function CompanyEditor({
  company,
  tenantId,
  propertyId,
  currency,
  roomTypes,
  onUpdated,
  onRequestDelete,
  busyRow,
}: CompanyEditorProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);

  // Editable fields, seeded from the row and re-seeded when the row changes from
  // outside (React's adjust-state-on-prop-change pattern, as the form primitives do).
  const [name, setName] = useState(company.name);
  const [contactName, setContactName] = useState(company.contact_name ?? '');
  const [contactPhone, setContactPhone] = useState(company.contact_phone ?? '');
  const [contactEmail, setContactEmail] = useState(company.contact_email ?? '');
  const [address, setAddress] = useState(company.address ?? '');
  const [notes, setNotes] = useState(company.notes ?? '');
  const [isActive, setIsActive] = useState(company.is_active);
  const [saving, setSaving] = useState(false);

  const [lastCompany, setLastCompany] = useState(company);
  if (company !== lastCompany) {
    setLastCompany(company);
    setName(company.name);
    setContactName(company.contact_name ?? '');
    setContactPhone(company.contact_phone ?? '');
    setContactEmail(company.contact_email ?? '');
    setAddress(company.address ?? '');
    setNotes(company.notes ?? '');
    setIsActive(company.is_active);
  }

  // Rates for this company, loaded lazily on first expand.
  const [rates, setRates] = useState<CompanyRate[]>([]);
  const [ratesLoaded, setRatesLoaded] = useState(false);
  const [ratesError, setRatesError] = useState<string | null>(null);

  const loadRates = useCallback(async () => {
    try {
      const rows = await fetchCompanyRates(company.id, tenantId);
      setRates(rows);
      setRatesLoaded(true);
      setRatesError(null);
    } catch (e) {
      setRatesError(humanizeError(e));
    }
  }, [company.id, tenantId]);

  useEffect(() => {
    void (async () => {
      if (expanded && !ratesLoaded) await loadRates();
    })();
  }, [expanded, ratesLoaded, loadRates]);

  const ratesByType = new Map<string, CompanyRate>();
  for (const r of rates) ratesByType.set(r.room_type_id, r);

  async function handleSaveDetails() {
    if (!name.trim()) {
      toast.error('A company name is required.');
      return;
    }
    setSaving(true);
    try {
      const row = await updateCompany(company.id, tenantId, {
        name: name.trim(),
        contact_name: contactName.trim() || null,
        contact_phone: contactPhone.trim() || null,
        contact_email: contactEmail.trim() || null,
        address: address.trim() || null,
        notes: notes.trim() || null,
        is_active: isActive,
      });
      onUpdated(row);
      toast.success('Company updated.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      {/* Summary row */}
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream rounded-lg"
        >
          <ChevronDownIcon
            className={`h-5 w-5 shrink-0 text-charcoal-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="min-w-0">
            <span className="flex items-center gap-2">
              <span className="truncate font-semibold text-charcoal">
                {company.name}
              </span>
              {!company.is_active ? (
                <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                  Dormant
                </span>
              ) : null}
            </span>
            <span className="block truncate text-xs text-charcoal-muted">
              {company.contact_name || company.contact_phone || 'No contact set'}
            </span>
          </span>
        </button>
        <button
          type="button"
          onClick={() => onRequestDelete(company)}
          disabled={busyRow}
          className="rounded-lg px-3 py-1.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
        >
          Remove
        </button>
      </div>

      {expanded ? (
        <div className="space-y-5 border-t border-sand-border p-4">
          {/* Details */}
          <section>
            <h3 className="mb-3 text-sm font-semibold text-charcoal">Details</h3>
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Company name" required value={name} onChange={setName} disabled={saving} />
              <TextField label="Contact name" value={contactName} onChange={setContactName} disabled={saving} />
              <TextField label="Contact phone" value={contactPhone} onChange={setContactPhone} disabled={saving} />
              <TextField label="Contact email" value={contactEmail} onChange={setContactEmail} disabled={saving} />
              <div className="sm:col-span-2">
                <TextField label="Address" value={address} onChange={setAddress} disabled={saving} />
              </div>
              <div className="sm:col-span-2">
                <TextArea label="Notes" value={notes} onChange={setNotes} disabled={saving} rows={2} />
              </div>
              <Toggle
                label="Active account"
                value={isActive}
                onChange={setIsActive}
                disabled={saving}
                helpText="Turn off to keep the account on file but hide it from new bookings."
              />
            </div>
            <div className="mt-4">
              <button
                type="button"
                onClick={() => void handleSaveDetails()}
                disabled={saving}
                className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                {saving ? 'Saving…' : 'Save details'}
              </button>
            </div>
          </section>

          {/* Negotiated rates */}
          <section>
            <h3 className="mb-1 text-sm font-semibold text-charcoal">
              Negotiated rates
            </h3>
            <p className="mb-3 text-xs text-charcoal-muted">
              Set a fixed price or a percentage off rack, per room type. A type
              with no rate simply pays rack.
            </p>
            {ratesError ? (
              <p className="text-sm text-charcoal-muted">{ratesError}</p>
            ) : !ratesLoaded ? (
              <p className="text-sm text-charcoal-muted" aria-live="polite">
                Loading rates…
              </p>
            ) : (
              <CompanyRatesEditor
                tenantId={tenantId}
                propertyId={propertyId}
                companyId={company.id}
                currency={currency}
                roomTypes={roomTypes}
                ratesByType={ratesByType}
                onChanged={() => void loadRates()}
              />
            )}
          </section>

          {/* Preview */}
          {ratesLoaded ? (
            <CompanyRatePreview
              companyId={company.id}
              roomTypes={roomTypes}
              currency={currency}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
