import { useState } from 'react';
import { useToast } from '../../ui/Toast';
import { CurrencyField, NumberField, Select } from '../../ui/form';
import { humanizeError } from '../../../lib/errors';
import { formatCurrency, parseNumeric, MISSING_VALUE } from '../../../lib/format';
import {
  createCompanyRate,
  updateCompanyRate,
  softDeleteCompanyRate,
} from '../../../lib/companies';
import type { CompanyRate, CompanyRateMode } from '../../../types/company';
import type { RoomType } from '../../../types/room';

// The negotiated-rates editor for one company (build 6b §2): one row per room
// type, each with the fixed-or-percentage toggle and its value. A company has at
// most one LIVE rate per type (016 partial unique index), so each row edits that
// single rate — create it, change it, or clear it (soft-delete → the company
// falls back to paying rack for that type, which is not an error).
//
// Admin-gated at the DB (016 policies); every write is awaited in try/catch and
// surfaced (rule 11). Numeric values are parsed (§6) before display.

interface CompanyRatesEditorProps {
  tenantId: string;
  propertyId: string;
  companyId: string;
  currency: string;
  roomTypes: RoomType[];
  // Live rates for this company, keyed by room_type_id (built by the caller).
  ratesByType: Map<string, CompanyRate>;
  onChanged: () => void; // re-pull rates after a write
}

export function CompanyRatesEditor({
  tenantId,
  propertyId,
  companyId,
  currency,
  roomTypes,
  ratesByType,
  onChanged,
}: CompanyRatesEditorProps) {
  if (roomTypes.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-sand-border bg-white/40 px-4 py-6 text-center text-sm text-charcoal-muted">
        This property has no room types yet. Add room types first, then set this
        company’s negotiated rate for each.
      </p>
    );
  }

  return (
    <ul className="space-y-2">
      {roomTypes.map((rt) => (
        <li key={rt.id}>
          <RateRow
            tenantId={tenantId}
            propertyId={propertyId}
            companyId={companyId}
            currency={currency}
            roomType={rt}
            existing={ratesByType.get(rt.id) ?? null}
            onChanged={onChanged}
          />
        </li>
      ))}
    </ul>
  );
}

interface RateRowProps {
  tenantId: string;
  propertyId: string;
  companyId: string;
  currency: string;
  roomType: RoomType;
  existing: CompanyRate | null;
  onChanged: () => void;
}

function RateRow({
  tenantId,
  propertyId,
  companyId,
  currency,
  roomType,
  existing,
  onChanged,
}: RateRowProps) {
  const toast = useToast();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<CompanyRateMode>(
    existing?.rate_mode ?? 'percentage',
  );
  const [fixed, setFixed] = useState<number | null>(
    parseNumeric(existing?.fixed_rate ?? null),
  );
  const [percent, setPercent] = useState<number | null>(
    parseNumeric(existing?.discount_percent ?? null),
  );
  const [busy, setBusy] = useState(false);

  function openEdit() {
    setMode(existing?.rate_mode ?? 'percentage');
    setFixed(parseNumeric(existing?.fixed_rate ?? null));
    setPercent(parseNumeric(existing?.discount_percent ?? null));
    setEditing(true);
  }

  async function handleSave() {
    // Validate the value for the chosen mode before writing.
    if (mode === 'fixed') {
      if (fixed === null || fixed < 0) {
        toast.error('Enter a fixed nightly rate (0 or more).');
        return;
      }
    } else if (percent === null || percent < 0 || percent > 100) {
      toast.error('Enter a discount between 0 and 100 percent.');
      return;
    }

    const values = {
      rate_mode: mode,
      fixed_rate: mode === 'fixed' ? fixed : null,
      discount_percent: mode === 'percentage' ? percent : null,
    };

    setBusy(true);
    try {
      if (existing) {
        await updateCompanyRate(existing.id, tenantId, values);
      } else {
        await createCompanyRate(
          tenantId,
          propertyId,
          companyId,
          roomType.id,
          values,
        );
      }
      toast.success(`Rate saved for ${roomType.name}.`);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function handleClear() {
    if (!existing) return;
    if (
      !window.confirm(
        `Clear the negotiated rate for "${roomType.name}"? This company will then pay the rack rate for it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await softDeleteCompanyRate(existing.id, tenantId);
      toast.success(`Rate cleared for ${roomType.name}.`);
      setEditing(false);
      onChanged();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const rackLabel = formatCurrency(roomType.base_rate, currency);

  return (
    <div className="rounded-xl border border-sand-border bg-white/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-charcoal">
            {roomType.name}
          </p>
          <p className="text-xs text-charcoal-muted">
            Rack {rackLabel} · {existingSummary(existing, currency)}
          </p>
        </div>
        {!editing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={openEdit}
              disabled={busy}
              className="rounded-lg border border-sand-border bg-white/70 px-3 py-1.5 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {existing ? 'Edit rate' : 'Set rate'}
            </button>
            {existing ? (
              <button
                type="button"
                onClick={() => void handleClear()}
                disabled={busy}
                className="rounded-lg px-3 py-1.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
              >
                Clear
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {editing ? (
        <div className="mt-3 border-t border-sand-border pt-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Select
              label="Rate type"
              value={mode}
              onChange={(v) => setMode(v as CompanyRateMode)}
              disabled={busy}
              options={[
                { value: 'percentage', label: 'Percentage off rack' },
                { value: 'fixed', label: 'Fixed nightly price' },
              ]}
              helpText={
                mode === 'fixed'
                  ? 'A flat price the hotel honours regardless of weekend or seasonal changes.'
                  : 'A standing discount off whatever the rack rate is that night.'
              }
            />
            {mode === 'fixed' ? (
              <CurrencyField
                label="Fixed nightly rate"
                required
                currency={currency}
                value={fixed}
                onChange={setFixed}
                disabled={busy}
              />
            ) : (
              <NumberField
                label="Discount percent"
                required
                value={percent}
                onChange={setPercent}
                min={0}
                max={100}
                step="any"
                disabled={busy}
                helpText="0–100. e.g. 20 means 20% off the resolved rack rate."
              />
            )}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={busy}
              className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save rate'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={busy}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-xs font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// A one-line summary of the live rate for the row header.
function existingSummary(rate: CompanyRate | null, currency: string): string {
  if (!rate) return 'Pays rack';
  if (rate.rate_mode === 'fixed') {
    const v = parseNumeric(rate.fixed_rate);
    return v === null
      ? MISSING_VALUE
      : `Fixed ${formatCurrency(v, currency)}/night`;
  }
  const p = parseNumeric(rate.discount_percent);
  return p === null ? MISSING_VALUE : `${p}% off rack`;
}
