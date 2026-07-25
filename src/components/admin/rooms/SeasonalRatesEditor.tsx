import { useEffect, useState } from 'react';
import { useToast } from '../../ui/Toast';
import { TextField, CurrencyField, controlClasses } from '../../ui/form';
import { PlusIcon, EditIcon, CloseIcon } from '../../ui/icons';
import { formatCurrency, parseNumeric } from '../../../lib/format';
import { humanizeError } from '../../../lib/errors';
import {
  fetchSeasonalRates,
  createSeasonalRate,
  updateSeasonalRate,
  softDeleteSeasonalRate,
  type SeasonalRateWrite,
} from '../../../lib/roomTypes';
import type { SeasonalRate } from '../../../types/room';

// The seasonal-rates sub-list for one room type (build 5a §3). Add / edit /
// remove named, dated overrides — each persists IMMEDIATELY (its own action, like
// the image list), awaited in try/catch with the error surfaced (rule 11).
//
// Overlaps between periods are ALLOWED (the schema deliberately omits an overlap
// constraint, 012); resolve_room_rate resolves precedence, so this editor never
// blocks an overlap. It bubbles the current list up via onChanged so the parent's
// rate preview can explain which rule fires on the chosen date.

interface SeasonalRatesEditorProps {
  tenantId: string;
  propertyId: string;
  roomTypeId: string;
  currency: string;
  disabled?: boolean;
  onChanged?: (rates: SeasonalRate[]) => void;
}

interface Draft {
  name: string;
  start_date: string; // 'YYYY-MM-DD'
  end_date: string;
  rate: number | null;
}

const EMPTY_DRAFT: Draft = {
  name: '',
  start_date: '',
  end_date: '',
  rate: null,
};

export function SeasonalRatesEditor({
  tenantId,
  propertyId,
  roomTypeId,
  currency,
  disabled,
  onChanged,
}: SeasonalRatesEditorProps) {
  const toast = useToast();
  const [rates, setRates] = useState<SeasonalRate[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  // 'new' = adding; an id = editing that row; null = list view.
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [errors, setErrors] = useState<Partial<Record<keyof Draft, string>>>({});
  const [busy, setBusy] = useState(false);

  // Load once per room type. await-first, cancelled guard — the codebase shape.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const rows = await fetchSeasonalRates(roomTypeId, tenantId);
        if (cancelled) return;
        setRates(rows);
        setLoadError(null);
        onChanged?.(rows);
      } catch (e) {
        if (!cancelled) setLoadError(humanizeError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // onChanged is a stable callback from the parent; roomTypeId/tenantId drive it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomTypeId, tenantId]);

  function applyRows(rows: SeasonalRate[]) {
    setRates(rows);
    onChanged?.(rows);
  }

  function startAdd() {
    setDraft(EMPTY_DRAFT);
    setErrors({});
    setEditing('new');
  }

  function startEdit(rate: SeasonalRate) {
    setDraft({
      name: rate.name,
      start_date: rate.start_date,
      end_date: rate.end_date,
      rate: parseNumeric(rate.rate),
    });
    setErrors({});
    setEditing(rate.id);
  }

  function cancel() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setErrors({});
  }

  function validate(): SeasonalRateWrite | null {
    const found: Partial<Record<keyof Draft, string>> = {};
    const name = draft.name.trim();
    if (!name) found.name = 'A name is required.';
    if (!draft.start_date) found.start_date = 'Pick a start date.';
    if (!draft.end_date) found.end_date = 'Pick an end date.';
    // ISO 'YYYY-MM-DD' strings compare lexicographically, so this matches the
    // DB's end_date >= start_date check (012) without parsing to Date objects.
    if (
      draft.start_date &&
      draft.end_date &&
      draft.end_date < draft.start_date
    ) {
      found.end_date = 'End date cannot be before the start date.';
    }
    if (draft.rate === null) found.rate = 'Enter a nightly rate.';
    else if (draft.rate < 0) found.rate = 'Rate cannot be negative.';

    setErrors(found);
    if (Object.keys(found).length > 0) return null;
    return {
      name,
      start_date: draft.start_date,
      end_date: draft.end_date,
      rate: draft.rate as number,
    };
  }

  async function save() {
    const values = validate();
    if (!values) return;
    setBusy(true);
    try {
      if (editing === 'new') {
        const created = await createSeasonalRate(
          tenantId,
          propertyId,
          roomTypeId,
          values,
        );
        applyRows([created, ...rates]);
        toast.success('Seasonal rate added.');
      } else if (editing) {
        const updated = await updateSeasonalRate(editing, tenantId, values);
        applyRows(rates.map((r) => (r.id === updated.id ? updated : r)));
        toast.success('Seasonal rate updated.');
      }
      cancel();
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(rate: SeasonalRate) {
    if (
      !window.confirm(
        `Remove the "${rate.name}" seasonal rate? Its pricing history is kept, but it will no longer apply.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await softDeleteSeasonalRate(rate.id, tenantId);
      applyRows(rates.filter((r) => r.id !== rate.id));
      toast.success('Seasonal rate removed.');
    } catch (e) {
      toast.error(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  const locked = disabled || busy;

  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="text-sm font-medium text-charcoal">
          Seasonal rates
        </span>
        <span className="text-xs text-charcoal-muted">
          {rates.length} period{rates.length === 1 ? '' : 's'}
        </span>
      </div>
      <p className="mb-3 text-xs text-charcoal-muted">
        Dated overrides like Christmas or a festival weekend. Overlaps are fine —
        the most recently added one wins on a shared date.
      </p>

      {loadError ? (
        <p role="alert" className="mb-3 text-xs font-medium text-primary">
          Couldn’t load seasonal rates: {loadError}
        </p>
      ) : loading ? (
        <p className="mb-3 text-xs text-charcoal-muted">Loading…</p>
      ) : rates.length === 0 ? (
        <div className="mb-3 rounded-xl border border-dashed border-sand-border bg-white/40 px-4 py-4 text-center text-xs text-charcoal-muted">
          No seasonal rates yet.
        </div>
      ) : (
        <ul className="mb-3 space-y-2">
          {rates.map((rate) => (
            <li
              key={rate.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sand-border bg-white/60 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-charcoal">
                  {rate.name}
                </p>
                <p className="text-xs text-charcoal-muted">
                  {rate.start_date} → {rate.end_date} ·{' '}
                  <span className="font-medium text-charcoal">
                    {formatCurrency(rate.rate, currency)}
                  </span>{' '}
                  / night
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <IconBtn
                  label={`Edit ${rate.name}`}
                  onClick={() => startEdit(rate)}
                  disabled={locked}
                >
                  <EditIcon className="h-4 w-4" />
                </IconBtn>
                <IconBtn
                  label={`Remove ${rate.name}`}
                  onClick={() => void remove(rate)}
                  disabled={locked}
                >
                  <CloseIcon className="h-4 w-4" />
                </IconBtn>
              </div>
            </li>
          ))}
        </ul>
      )}

      {editing !== null ? (
        <div className="rounded-xl border border-sand-border bg-sand/40 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <TextField
                label="Name"
                required
                value={draft.name}
                onChange={(v) => setDraft((d) => ({ ...d, name: v }))}
                error={errors.name}
                placeholder="e.g. Christmas"
                disabled={busy}
              />
            </div>
            <DateField
              label="Start date"
              required
              value={draft.start_date}
              onChange={(v) => setDraft((d) => ({ ...d, start_date: v }))}
              error={errors.start_date}
              disabled={busy}
            />
            <DateField
              label="End date"
              required
              value={draft.end_date}
              onChange={(v) => setDraft((d) => ({ ...d, end_date: v }))}
              error={errors.end_date}
              disabled={busy}
            />
            <div className="sm:col-span-2">
              <CurrencyField
                label="Nightly rate"
                required
                currency={currency}
                value={draft.rate}
                onChange={(v) => setDraft((d) => ({ ...d, rate: v }))}
                error={errors.rate}
                disabled={busy}
              />
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => void save()}
              disabled={busy}
              className="rounded-full bg-accent px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {busy ? 'Saving…' : editing === 'new' ? 'Add rate' : 'Save rate'}
            </button>
            <button
              type="button"
              onClick={cancel}
              disabled={busy}
              className="rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={startAdd}
          disabled={locked}
          className="inline-flex items-center gap-1.5 rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-60"
        >
          <PlusIcon className="h-4 w-4" />
          Add seasonal rate
        </button>
      )}
    </div>
  );
}

// A native date input wrapped to match the form primitives' label/error layout.
// (The shared form set has no DateField yet; this is a local, minimal one used by
// the seasonal sub-list.) MISSING_VALUE is imported for parity with the rest of
// the app but a date input renders its own empty state, so it is not shown here.
interface DateFieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  required?: boolean;
  disabled?: boolean;
}

function DateField({
  label,
  value,
  onChange,
  error,
  required,
  disabled,
}: DateFieldProps) {
  return (
    <label className="block w-full">
      <span className="mb-1 block text-sm font-medium text-charcoal">
        {label}
        {required ? (
          <>
            {' '}
            <span className="text-primary" aria-hidden="true">
              *
            </span>
            <span className="sr-only">(required)</span>
          </>
        ) : null}
      </span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={required}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        className={controlClasses}
      />
      {error ? (
        <p role="alert" className="mt-1 text-xs font-medium text-primary">
          {error}
        </p>
      ) : null}
    </label>
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
      className="rounded-md p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}
