import { useEffect, useState } from 'react';
import { CurrencyField, DateField, NumberField, Select, TextField } from '../../ui/form';
import { useToast } from '../../ui/Toast';
import { todayIsoInZone } from '../../../lib/date';
import { describeError } from '../../../lib/errors';
import { formatMoney, formatRatePercent, MISSING_VALUE } from '../../../lib/format';
import {
  fetchActiveTaxCharges,
  fetchChargeCategories,
  folioErrorMessage,
  newIdempotencyKey,
  postCharge,
  previewChargeTaxes,
} from '../../../lib/folio';
import type { ChargeCategory, TaxCharge } from '../../../types/folio';
import { FolioActionCard } from './FolioActionCard';

// "Add charge" (brief §3) — a MANUAL posting by the front desk.
//
// WHAT THIS IS FOR: the extras a guest signs to their room — a restaurant or bar
// bill, a laundry ticket, an internet voucher, a transport run, a damaged item.
// Any of them, because the category list is a TABLE, not a hardcoded menu: adding
// "Spa" or "Conference hall" is a row in charge_categories, never a code change
// (021 §1 — the extension point of the whole engine).
//
// WHAT THIS IS NOT FOR: ROOM NIGHTS. They are posted automatically, one per night,
// by post_room_night_charge at night audit (021 §9.2), at the rate LOCKED in
// booking_nights when the booking was made, under a deterministic
// 'room:<booking>:<date>' idempotency key so a re-run of the audit cannot
// double-post. A receptionist must never key a room night by hand — it would post
// at whatever rate they typed, outside the locked-rate guarantee, and the audit
// would then post it again. Room charges arrive on their own.

interface AddChargeFormProps {
  folioId: string;
  tenantId: string;
  propertyId: string;
  currency: string;
  timezone: string;
  // ---- STANDALONE MODE (2.txt §2) ------------------------------------------
  // A charge on the guest's NON-RESIDENT folio is the same act against a
  // different folio — the same post_charge, the same categories, the same tax
  // preview — so it is this form with its words changed, never a second charge
  // screen that could drift from this one. Two differences, both deliberate:
  // the description becomes REQUIRED (a charge tied to no stay is
  // unexplainable a month later without one), and `source` is passed as
  // 'standalone' so the bill and every later report can tell the two apart
  // without inspecting the folio.
  title?: string;
  description?: string;
  descriptionLabel?: string;
  descriptionHelp?: string;
  descriptionPlaceholder?: string;
  descriptionRequired?: boolean;
  source?: string;
  onDone: () => Promise<void> | void;
  onCancel: () => void;
}

export function AddChargeForm({
  folioId,
  tenantId,
  propertyId,
  currency,
  timezone,
  title = 'Add charge',
  description: blurb = 'For extras signed to the room — food & beverage, laundry, internet, transport. Room nights post automatically at night audit and are never added here.',
  descriptionLabel = 'Description',
  descriptionHelp,
  descriptionPlaceholder = 'e.g. Dinner — table 4, laundry ticket 218',
  descriptionRequired = false,
  source,
  onDone,
  onCancel,
}: AddChargeFormProps) {
  const toast = useToast();

  const [categories, setCategories] = useState<ChargeCategory[]>([]);
  const [taxes, setTaxes] = useState<TaxCharge[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [categoryId, setCategoryId] = useState('');
  const [description, setDescription] = useState('');
  const [quantity, setQuantity] = useState<number | null>(1);
  const [unitAmount, setUnitAmount] = useState<number | null>(null);
  const [date, setDate] = useState(todayIsoInZone(timezone));
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cats, taxRows] = await Promise.all([
          fetchChargeCategories(tenantId),
          fetchActiveTaxCharges(tenantId, propertyId),
        ]);
        if (cancelled) return;
        setCategories(cats);
        setTaxes(taxRows);
      } catch (e) {
        // Rule 11: a load failure is shown, not swallowed — without the category
        // list there is nothing to post against, so the form says why.
        if (!cancelled) setLoadError(describeError(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [tenantId, propertyId]);

  const category = categories.find((c) => c.id === categoryId) ?? null;

  // gross = quantity × unit, rounded to money precision ONCE — the same single
  // rounding post_charge performs server-side (021 §9.1), so the figure previewed
  // is the figure posted.
  const gross =
    quantity !== null && unitAmount !== null
      ? Math.round(quantity * unitAmount * 100) / 100
      : null;

  // The ESTIMATE. A manual charge posts with no discount, so its net equals its
  // gross and the tax preview runs on that. See previewChargeTaxes: this is the
  // one place the applicability rule is restated for a row that does not exist
  // yet, and nothing on a posted bill is ever computed with it.
  const previewTaxes =
    gross !== null && gross > 0 ? previewChargeTaxes(taxes, category, gross) : [];
  const previewTaxTotal = previewTaxes.reduce((sum, t) => sum + t.amount, 0);

  const canSubmit =
    categoryId !== '' &&
    quantity !== null &&
    quantity > 0 &&
    unitAmount !== null &&
    unitAmount >= 0 &&
    date !== '' &&
    (!descriptionRequired || description.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    try {
      await postCharge({
        folioId,
        chargeCategoryId: categoryId,
        description: description.trim() || null,
        quantity: quantity as number,
        unitAmount: unitAmount as number,
        chargeDate: date || null,
        // Fresh key per submit intent (rules 2/3); folio_charges_idem_uniq is the
        // guard that makes a double-click return the first charge, not post a
        // second one.
        idempotencyKey: newIdempotencyKey(),
        source,
      });
      toast.success('Charge posted.');
      await onDone();
    } catch (e) {
      toast.error(folioErrorMessage(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <FolioActionCard
      title={title}
      description={blurb}
      submitLabel="Post charge"
      submittingLabel="Posting…"
      submitting={submitting}
      canSubmit={canSubmit && !loadError}
      onSubmit={() => void handleSubmit()}
      onCancel={onCancel}
    >
      {loadError ? (
        <p className="rounded-lg border border-sand-border bg-cream px-3 py-2 text-xs text-charcoal">
          {loadError}
        </p>
      ) : null}

      <Select
        label="Charge type"
        required
        value={categoryId}
        onChange={setCategoryId}
        disabled={submitting}
        placeholder="Select a charge type…"
        options={categories.map((c) => ({ value: c.id, label: c.name }))}
        helpText="The hotel's own list — add or retire types in the charge categories, not in code."
      />

      <TextField
        label={descriptionLabel}
        required={descriptionRequired}
        value={description}
        onChange={setDescription}
        disabled={submitting}
        placeholder={descriptionPlaceholder}
        helpText={descriptionHelp}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <NumberField
          label="Quantity"
          required
          value={quantity}
          onChange={setQuantity}
          min={0}
          step="any"
          disabled={submitting}
        />
        <CurrencyField
          label="Unit amount"
          required
          value={unitAmount}
          onChange={setUnitAmount}
          currency={currency}
          disabled={submitting}
        />
      </div>

      <DateField
        label="Charge date"
        required
        value={date}
        onChange={setDate}
        disabled={submitting}
        helpText="The business date the charge belongs to — a bar sale at 02:00 belongs to the previous operating day."
      />

      {/* What this will actually cost the guest, BEFORE it is posted (brief §3):
          staff quoting a room-service item should see the taxed figure, not the
          bare price. Labelled an estimate because it is computed for a row that
          does not exist yet; once posted, every figure on the bill comes from the
          database (folio_charge_taxes / folio_totals). */}
      {gross !== null && gross > 0 && category ? (
        <div className="rounded-lg border border-sand-border bg-sand/30 p-3">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="text-charcoal-muted">Gross</span>
            <span className="font-semibold tabular-nums text-charcoal">
              {formatMoney(gross, currency)}
            </span>
          </div>
          {previewTaxes.length > 0 ? (
            previewTaxes.map((t) => (
              <div
                key={t.code}
                className="mt-1 flex items-baseline justify-between gap-3 text-xs text-charcoal-muted"
              >
                <span>
                  {t.name} ({formatRatePercent(t.rate)})
                </span>
                <span className="tabular-nums">
                  {formatMoney(t.amount, currency)}
                </span>
              </div>
            ))
          ) : (
            <p className="mt-1 text-xs text-charcoal-muted">
              This charge type attracts no tax or service charge.
            </p>
          )}
          <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-sand-border pt-2 text-sm">
            <span className="font-semibold text-charcoal">
              Guest pays (estimated)
            </span>
            <span className="font-bold tabular-nums text-charcoal">
              {formatMoney(gross + previewTaxTotal, currency)}
            </span>
          </div>
          <p className="mt-1.5 text-[11px] text-charcoal-muted">
            Estimate, computed from this property's active taxes and this charge
            type's settings. Once posted, every figure on the bill is computed by
            the database.
          </p>
        </div>
      ) : (
        <p className="text-xs text-charcoal-muted">
          {category
            ? 'Enter a quantity and unit amount to see the tax that will apply.'
            : `Select a charge type to see the tax that will apply. ${MISSING_VALUE}`}
        </p>
      )}
    </FolioActionCard>
  );
}
