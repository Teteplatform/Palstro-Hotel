import { useEffect, useMemo, useState } from 'react';
import { useToast } from '../../ui/Toast';
import {
  TextField,
  TextArea,
  NumberField,
  CurrencyField,
  Toggle,
  StringListField,
} from '../../ui/form';
import { ArrowUpIcon, ArrowDownIcon, CloseIcon } from '../../ui/icons';
import {
  formatCurrency,
  formatOccupancy,
  MISSING_VALUE,
} from '../../../lib/format';
import { humanizeError } from '../../../lib/errors';
import { updateRoomType, resolveRoomRate } from '../../../lib/roomTypes';
import type { MediaAssetMap } from '../../../lib/mediaUrl';
import type { RoomType, SeasonalRate } from '../../../types/room';
import { RoomTypeImages } from './RoomTypeImages';
import { SeasonalRatesEditor } from './SeasonalRatesEditor';

// One room type's editable card (build 5a §3). Two persistence styles, matching
// the settings/media split already in the codebase:
//   * SCALAR fields (name, occupancy, rates, toggles, amenities) edit into a local
//     draft and persist via an explicit "Save changes" button (dirty-tracked).
//   * IMAGES, DISPLAY ORDER and SEASONAL RATES are their own immediate actions
//     (an uploaded file / a reorder / a dated override cannot sit un-persisted),
//     each awaited in try/catch with the error surfaced (rule 11).
//
// The rate PREVIEW calls resolve_room_rate (the server's single source of truth,
// 012) for the screen's chosen date; a small client-side reason label explains
// which rule fired, derived from the same precedence the function uses.

// ISO weekday numbering (Mon=1 .. Sun=7), matching weekend_days / extract(isodow).
const WEEKDAYS: { iso: number; short: string; full: string }[] = [
  { iso: 1, short: 'M', full: 'Monday' },
  { iso: 2, short: 'T', full: 'Tuesday' },
  { iso: 3, short: 'W', full: 'Wednesday' },
  { iso: 4, short: 'T', full: 'Thursday' },
  { iso: 5, short: 'F', full: 'Friday' },
  { iso: 6, short: 'S', full: 'Saturday' },
  { iso: 7, short: 'S', full: 'Sunday' },
];

// ISO day-of-week (Mon=1 .. Sun=7) for a 'YYYY-MM-DD' date, mirroring the server's
// extract(isodow) so the client reason label agrees with resolve_room_rate.
function isoDow(dateStr: string): number | null {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return ((d.getUTCDay() + 6) % 7) + 1; // getUTCDay Sun=0 -> isodow Sun=7
}

interface Draft {
  name: string;
  description: string;
  bed_configuration: string;
  size_sqm: number | null;
  max_adults: number | null;
  max_children: number | null;
  amenities: string[];
  has_air_conditioning: boolean;
  is_smoking: boolean;
  is_published: boolean;
  base_rate: number | null;
  weekend_rate: number | null;
  weekend_days: number[];
}

function toDraft(rt: RoomType): Draft {
  return {
    name: rt.name,
    description: rt.description ?? '',
    bed_configuration: rt.bed_configuration ?? '',
    size_sqm: rt.size_sqm,
    max_adults: rt.max_adults,
    max_children: rt.max_children,
    amenities: rt.amenities ?? [],
    has_air_conditioning: rt.has_air_conditioning,
    is_smoking: rt.is_smoking,
    is_published: rt.is_published,
    base_rate: rt.base_rate,
    weekend_rate: rt.weekend_rate,
    weekend_days: rt.weekend_days ?? [],
  };
}

interface RoomTypeEditorProps {
  roomType: RoomType;
  tenantId: string;
  propertyId: string;
  currency: string;
  mediaMap: MediaAssetMap;
  reloadMedia: () => Promise<void>;
  previewDate: string;
  index: number;
  total: number;
  onUpdated: (row: RoomType) => void;
  onMove: (index: number, dir: -1 | 1) => void;
  onRequestDelete: (roomType: RoomType) => void;
  busyRow?: boolean;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export function RoomTypeEditor({
  roomType,
  tenantId,
  propertyId,
  currency,
  mediaMap,
  reloadMedia,
  previewDate,
  index,
  total,
  onUpdated,
  onMove,
  onRequestDelete,
  busyRow,
}: RoomTypeEditorProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState<Draft>(() => toDraft(roomType));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  // Seasonal rates bubbled up from the sub-editor, used ONLY to explain the
  // preview (the amount itself comes from the server function).
  const [seasonalRates, setSeasonalRates] = useState<SeasonalRate[]>([]);

  // Preview state for the screen's chosen date.
  const [previewRate, setPreviewRate] = useState<number | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  // Re-seed the draft when the underlying row changes IDENTITY from outside
  // (e.g. after an image/order write swaps in a fresh row) but the user is not
  // mid-edit on the scalar form. React's "adjust state on prop change" pattern:
  // a keyed remount would lose the expanded state, so we reconcile instead.
  const [lastRowKey, setLastRowKey] = useState(roomType.updated_at);
  if (roomType.updated_at !== lastRowKey) {
    setLastRowKey(roomType.updated_at);
    // Only overwrite the draft when the form is clean, so a concurrent image save
    // never stomps half-typed scalar edits.
    setDraft((prev) => (dirtyOf(prev, roomType) ? prev : toDraft(roomType)));
  }

  const dirty = useMemo(() => dirtyOf(draft, roomType), [draft, roomType]);

  // Resolve the rate for the preview date. Re-runs when the date changes, when the
  // row is saved (updated_at moves), or when a seasonal rate is added/removed.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPreviewLoading(true);
      try {
        const rate = await resolveRoomRate(roomType.id, previewDate);
        if (cancelled) return;
        setPreviewRate(rate);
        setPreviewError(null);
      } catch (e) {
        if (!cancelled) setPreviewError(humanizeError(e));
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [roomType.id, roomType.updated_at, previewDate, seasonalRates]);

  // Which rule the server applied, derived client-side for the label only. Mirrors
  // resolve_room_rate precedence: seasonal (newest covering the date) > weekend >
  // rack. seasonalRates is newest-first, so the first covering match is the winner.
  const previewReason = useMemo(() => {
    const covering = seasonalRates.find(
      (r) => previewDate >= r.start_date && previewDate <= r.end_date,
    );
    if (covering) return `Seasonal: ${covering.name}`;
    const dow = isoDow(previewDate);
    if (
      roomType.weekend_rate !== null &&
      dow !== null &&
      (roomType.weekend_days ?? []).includes(dow)
    ) {
      return 'Weekend rate';
    }
    return 'Rack rate';
  }, [seasonalRates, previewDate, roomType.weekend_rate, roomType.weekend_days]);

  function setField<K extends keyof Draft>(key: K, value: Draft[K]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key as string];
      return next;
    });
  }

  function toggleWeekendDay(iso: number) {
    setDraft((prev) => {
      const has = prev.weekend_days.includes(iso);
      const next = has
        ? prev.weekend_days.filter((d) => d !== iso)
        : [...prev.weekend_days, iso].sort((a, b) => a - b);
      return { ...prev, weekend_days: next };
    });
  }

  function validate(): boolean {
    const found: Record<string, string> = {};
    if (!draft.name.trim()) found.name = 'A name is required.';
    if (draft.base_rate === null) found.base_rate = 'Enter a rack rate.';
    else if (draft.base_rate < 0) found.base_rate = 'Rate cannot be negative.';
    if (draft.weekend_rate !== null && draft.weekend_rate < 0) {
      found.weekend_rate = 'Rate cannot be negative.';
    }
    if (draft.max_adults === null || draft.max_adults < 1) {
      found.max_adults = 'At least one adult.';
    }
    if (draft.max_children !== null && draft.max_children < 0) {
      found.max_children = 'Cannot be negative.';
    }
    if (draft.size_sqm !== null && draft.size_sqm < 0) {
      found.size_sqm = 'Cannot be negative.';
    }
    setErrors(found);
    return Object.keys(found).length === 0;
  }

  async function handleSave() {
    if (!validate()) {
      toast.error('Please fix the highlighted fields before saving.');
      return;
    }
    setSaving(true);
    try {
      const row = await updateRoomType(roomType.id, tenantId, propertyId, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        bed_configuration: draft.bed_configuration.trim() || null,
        size_sqm: draft.size_sqm,
        max_adults: draft.max_adults ?? 1,
        max_children: draft.max_children ?? 0,
        amenities: draft.amenities,
        has_air_conditioning: draft.has_air_conditioning,
        is_smoking: draft.is_smoking,
        is_published: draft.is_published,
        base_rate: draft.base_rate as number,
        weekend_rate: draft.weekend_rate,
        weekend_days: draft.weekend_days,
      });
      onUpdated(row);
      setDraft(toDraft(row));
      toast.success('Room type saved.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setSaving(false);
    }
  }

  // Persist a new image-id order for this type (called by RoomTypeImages). Returns
  // once the row is saved and swapped into the screen's state.
  async function persistImages(nextIds: string[]) {
    const row = await updateRoomType(roomType.id, tenantId, propertyId, {
      images: nextIds,
    });
    onUpdated(row);
  }

  const locked = saving || busyRow;

  return (
    <article className="rounded-2xl border border-sand-border bg-white/60">
      {/* Header row — always visible, so the list reads at a glance. */}
      <div className="flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-base font-semibold text-charcoal">
              {roomType.name}
            </h3>
            {!roomType.is_published ? (
              <span className="shrink-0 rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                Draft
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-charcoal-muted">
            {formatOccupancy(roomType.max_adults, roomType.max_children)} ·{' '}
            {formatCurrency(roomType.base_rate, currency)} rack
          </p>
        </div>

        {/* Preview for the chosen date. */}
        <div className="text-right">
          <p className="text-sm font-semibold text-charcoal">
            {previewLoading
              ? '…'
              : previewError
                ? MISSING_VALUE
                : formatCurrency(previewRate, currency)}
          </p>
          <p className="text-[11px] text-charcoal-muted">
            {previewError ? 'Preview failed' : previewReason}
          </p>
        </div>

        {/* Reorder + expand controls. */}
        <div className="flex shrink-0 items-center gap-1">
          <IconBtn
            label={`Move ${roomType.name} up`}
            onClick={() => onMove(index, -1)}
            disabled={locked || index === 0}
          >
            <ArrowUpIcon className="h-4 w-4" />
          </IconBtn>
          <IconBtn
            label={`Move ${roomType.name} down`}
            onClick={() => onMove(index, 1)}
            disabled={locked || index === total - 1}
          >
            <ArrowDownIcon className="h-4 w-4" />
          </IconBtn>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            className="rounded-lg border border-sand-border bg-white/70 px-3 py-1.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            {expanded ? 'Close' : 'Edit'}
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="space-y-6 border-t border-sand-border p-4">
          {/* --- Details ------------------------------------------------------ */}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <TextField
                label="Name"
                required
                value={draft.name}
                onChange={(v) => setField('name', v)}
                error={errors.name}
                disabled={saving}
              />
            </div>
            <div className="sm:col-span-2">
              <TextArea
                label="Description"
                value={draft.description}
                onChange={(v) => setField('description', v)}
                rows={3}
                disabled={saving}
              />
            </div>
            <TextField
              label="Bed configuration"
              value={draft.bed_configuration}
              onChange={(v) => setField('bed_configuration', v)}
              placeholder="e.g. 1 King"
              disabled={saving}
            />
            <NumberField
              label="Room size (m²)"
              value={draft.size_sqm}
              onChange={(v) => setField('size_sqm', v)}
              min={0}
              step="any"
              error={errors.size_sqm}
              disabled={saving}
            />
            <NumberField
              label="Max adults"
              required
              value={draft.max_adults}
              onChange={(v) => setField('max_adults', v)}
              min={1}
              step={1}
              error={errors.max_adults}
              disabled={saving}
            />
            <NumberField
              label="Max children"
              value={draft.max_children}
              onChange={(v) => setField('max_children', v)}
              min={0}
              step={1}
              error={errors.max_children}
              disabled={saving}
            />
            <div className="sm:col-span-2">
              <StringListField
                label="Amenities"
                value={draft.amenities}
                onChange={(v) => setField('amenities', v)}
                placeholder="e.g. Air conditioning, Balcony"
                disabled={saving}
              />
            </div>
            <Toggle
              label="Air conditioning"
              value={draft.has_air_conditioning}
              onChange={(v) => setField('has_air_conditioning', v)}
              disabled={saving}
            />
            <Toggle
              label="Smoking room"
              value={draft.is_smoking}
              onChange={(v) => setField('is_smoking', v)}
              disabled={saving}
            />
          </div>

          {/* --- Rates -------------------------------------------------------- */}
          <div className="rounded-xl border border-sand-border bg-sand/30 p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <CurrencyField
                label="Rack rate"
                required
                currency={currency}
                value={draft.base_rate}
                onChange={(v) => setField('base_rate', v)}
                helpText="The standard nightly price and the public “from” price."
                error={errors.base_rate}
                disabled={saving}
              />
              <CurrencyField
                label="Weekend rate"
                currency={currency}
                value={draft.weekend_rate}
                onChange={(v) => setField('weekend_rate', v)}
                helpText="Leave empty for no weekend premium (charges the rack rate)."
                error={errors.weekend_rate}
                disabled={saving}
              />
            </div>
            <div className="mt-3">
              <span className="mb-1 block text-sm font-medium text-charcoal">
                Weekend nights
              </span>
              <p className="mb-2 text-xs text-charcoal-muted">
                Which nights the weekend rate applies to.
              </p>
              <div className="flex flex-wrap gap-1.5">
                {WEEKDAYS.map((day) => {
                  const on = draft.weekend_days.includes(day.iso);
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      aria-pressed={on}
                      aria-label={day.full}
                      disabled={saving}
                      onClick={() => toggleWeekendDay(day.iso)}
                      className={`h-9 w-9 rounded-lg border text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60 ${
                        on
                          ? 'border-primary bg-primary text-white'
                          : 'border-sand-border bg-white/70 text-charcoal hover:bg-sand'
                      }`}
                    >
                      {day.short}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* --- Publish + Save ---------------------------------------------- */}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Toggle
              label="Published on the guest site"
              value={draft.is_published}
              onChange={(v) => setField('is_published', v)}
              helpText="Off keeps it as a draft, hidden from the public site."
              disabled={saving}
            />
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {saving ? 'Saving…' : dirty ? 'Save changes' : 'Saved'}
            </button>
          </div>

          {/* --- Photos ------------------------------------------------------- */}
          <RoomTypeImages
            tenantId={tenantId}
            propertyId={propertyId}
            imageIds={roomType.images ?? []}
            mediaMap={mediaMap}
            onPersist={persistImages}
            reloadMedia={reloadMedia}
            disabled={saving}
          />

          {/* --- Seasonal rates ---------------------------------------------- */}
          <SeasonalRatesEditor
            tenantId={tenantId}
            propertyId={propertyId}
            roomTypeId={roomType.id}
            currency={currency}
            disabled={saving}
            onChanged={setSeasonalRates}
          />

          {/* --- Danger: soft delete ----------------------------------------- */}
          <div className="flex items-center justify-between gap-3 border-t border-sand-border pt-4">
            <p className="text-xs text-charcoal-muted">
              Removing keeps this type’s history and any bookings against it; it
              simply leaves the guest site and this list.
            </p>
            <button
              type="button"
              onClick={() => onRequestDelete(roomType)}
              disabled={locked}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2 text-sm font-semibold text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
            >
              <CloseIcon className="h-4 w-4" />
              Remove room type
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

// Dirty comparison between the draft and the persisted row. Kept as a free
// function so the render-time "adjust state on prop change" reconciliation above
// can call it without depending on component state.
function dirtyOf(draft: Draft, rt: RoomType): boolean {
  return (
    draft.name !== rt.name ||
    draft.description !== (rt.description ?? '') ||
    draft.bed_configuration !== (rt.bed_configuration ?? '') ||
    draft.size_sqm !== rt.size_sqm ||
    draft.max_adults !== rt.max_adults ||
    draft.max_children !== rt.max_children ||
    !arraysEqual(draft.amenities, rt.amenities ?? []) ||
    draft.has_air_conditioning !== rt.has_air_conditioning ||
    draft.is_smoking !== rt.is_smoking ||
    draft.is_published !== rt.is_published ||
    draft.base_rate !== rt.base_rate ||
    draft.weekend_rate !== rt.weekend_rate ||
    !arraysEqual(draft.weekend_days, rt.weekend_days ?? [])
  );
}

function IconBtn({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-sand-border bg-white/70 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
