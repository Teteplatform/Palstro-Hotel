import { useEffect, useState } from 'react';
import { Select } from '../../ui/form';
import { formatCurrency, MISSING_VALUE } from '../../../lib/format';
import { todayIso } from '../../../lib/date';
import { humanizeError } from '../../../lib/errors';
import { previewCompanyRate, type RatePreview } from '../../../lib/companies';
import type { RoomType } from '../../../types/room';

// The rate preview (build 6b §2): pick a date and a room type and see what THIS
// company would pay versus rack — so the owner can confirm the discount is right
// before a guest ever books. Both figures come from the SERVER resolvers
// (resolve_booking_rate), the single source of truth create_booking locks from,
// so the preview cannot drift from what a real booking would charge.

interface CompanyRatePreviewProps {
  companyId: string;
  roomTypes: RoomType[];
  currency: string;
}

export function CompanyRatePreview({
  companyId,
  roomTypes,
  currency,
}: CompanyRatePreviewProps) {
  const [date, setDate] = useState<string>(() => todayIso());
  const [roomTypeId, setRoomTypeId] = useState<string>(
    () => roomTypes[0]?.id ?? '',
  );
  const [preview, setPreview] = useState<RatePreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!roomTypeId || !date) {
        setPreview(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const result = await previewCompanyRate(roomTypeId, date, companyId);
        if (cancelled) return;
        setPreview(result);
      } catch (e) {
        if (cancelled) return;
        setError(humanizeError(e));
        setPreview(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, roomTypeId, date]);

  if (roomTypes.length === 0) return null;

  const savings =
    preview && preview.rack !== null && preview.company !== null
      ? preview.rack - preview.company
      : null;

  return (
    <div className="rounded-xl border border-sand-border bg-sand/30 p-4">
      <h4 className="text-sm font-semibold text-charcoal">Rate preview</h4>
      <p className="mt-1 text-xs text-charcoal-muted">
        What this company pays versus rack on a chosen date. Uses the same pricing
        a real booking locks.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Select
          label="Room type"
          value={roomTypeId}
          onChange={setRoomTypeId}
          options={roomTypes.map((rt) => ({ value: rt.id, label: rt.name }))}
        />
        <label className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-charcoal">Date</span>
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm text-charcoal transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          />
        </label>
      </div>

      <div className="mt-4">
        {error ? (
          <p className="text-sm text-charcoal-muted">{error}</p>
        ) : loading ? (
          <p className="text-sm text-charcoal-muted" aria-live="polite">
            Resolving…
          </p>
        ) : preview ? (
          <div className="flex flex-wrap items-end gap-x-8 gap-y-2">
            <Figure
              label="Rack rate"
              value={
                preview.rack === null
                  ? MISSING_VALUE
                  : formatCurrency(preview.rack, currency)
              }
            />
            <Figure
              label="Company pays"
              value={
                preview.company === null
                  ? MISSING_VALUE
                  : formatCurrency(preview.company, currency)
              }
              emphasise
            />
            {savings !== null && savings > 0 ? (
              <p className="text-xs font-semibold text-accent">
                Saves {formatCurrency(savings, currency)}/night
              </p>
            ) : savings !== null && savings === 0 ? (
              <p className="text-xs text-charcoal-muted">Same as rack</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Figure({
  label,
  value,
  emphasise,
}: {
  label: string;
  value: string;
  emphasise?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-charcoal-muted">{label}</p>
      <p
        className={
          emphasise
            ? 'text-lg font-bold text-charcoal'
            : 'text-lg font-semibold text-charcoal-muted'
        }
      >
        {value}
      </p>
    </div>
  );
}
