import { useState } from 'react';
import { Select, TextField, Toggle } from '../../ui/form';
import type { SelectOption } from '../../ui/form';
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
} from '../../ui/icons';
import {
  locationKindHint,
  locationKindLabel,
  locationKindTone,
} from '../../../lib/inventoryLabels';
import type { LocationKind, StockLocation } from '../../../types/inventory';

// One stock location as a collapsible card: the summary row carries the name,
// the kind and whether it is in use; expanding reveals rename / change kind /
// in-use. Reorder and remove sit on the summary row, so the two things done
// most often need no expansion.
//
// Presentational and stateful only in the form sense — every write is performed
// by the parent screen, which owns the busy flag and the reload.

export interface LocationFormValues {
  name: string;
  kind: LocationKind;
  isActive: boolean;
}

interface LocationCardProps {
  location: StockLocation;
  kindOptions: SelectOption[];
  busy: boolean;
  isFirst: boolean;
  isLast: boolean;
  onSave: (values: LocationFormValues) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}

export function LocationCard({
  location,
  kindOptions,
  busy,
  isFirst,
  isLast,
  onSave,
  onMove,
  onRemove,
}: LocationCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [values, setValues] = useState<LocationFormValues>(() => toForm(location));

  // Re-seed when the row changes from outside (a reload after a save or a
  // reorder) — the adjust-state-on-prop-change pattern, not an effect.
  const [lastLocation, setLastLocation] = useState(location);
  if (location !== lastLocation) {
    setLastLocation(location);
    setValues(toForm(location));
  }

  const dirty =
    values.name.trim() !== location.name ||
    values.kind !== location.kind ||
    values.isActive !== location.is_active;

  return (
    <div className="rounded-2xl border border-sand-border bg-white/60">
      <div className="flex flex-wrap items-center justify-between gap-3 p-4">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <ChevronDownIcon
            className={`h-5 w-5 shrink-0 text-charcoal-muted transition-transform ${expanded ? 'rotate-180' : ''}`}
          />
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-2">
              <span className="truncate font-semibold text-charcoal">
                {location.name}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${locationKindTone(location.kind)}`}
              >
                {locationKindLabel(location.kind)}
              </span>
              {!location.is_active ? (
                <span className="rounded-full bg-charcoal/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
                  Not in use
                </span>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-xs text-charcoal-muted">
              {locationKindHint(location.kind)}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-1">
          <IconButton
            label={`Move ${location.name} up`}
            onClick={() => onMove(-1)}
            disabled={busy || isFirst}
          >
            <ArrowUpIcon className="h-4 w-4" />
          </IconButton>
          <IconButton
            label={`Move ${location.name} down`}
            onClick={() => onMove(1)}
            disabled={busy || isLast}
          >
            <ArrowDownIcon className="h-4 w-4" />
          </IconButton>
          <button
            type="button"
            onClick={onRemove}
            disabled={busy}
            className="rounded-lg px-3 py-1.5 text-xs font-semibold text-charcoal-muted transition-colors hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream disabled:opacity-60"
          >
            Remove
          </button>
        </div>
      </div>

      {expanded ? (
        <div className="border-t border-sand-border p-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Name"
              required
              value={values.name}
              onChange={(v) => setValues((prev) => ({ ...prev, name: v }))}
              disabled={busy}
            />
            <Select
              label="Kind"
              required
              value={values.kind}
              onChange={(v) =>
                setValues((prev) => ({ ...prev, kind: v as LocationKind }))
              }
              options={kindOptions}
              helpText={locationKindHint(values.kind)}
              disabled={busy}
            />
            <Toggle
              label="In use"
              value={values.isActive}
              onChange={(v) => setValues((prev) => ({ ...prev, isActive: v }))}
              helpText="Turn off to keep the location and its history on file but hide it from new entries."
              disabled={busy}
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!values.name.trim()) return;
                onSave({ ...values, name: values.name.trim() });
              }}
              disabled={busy || !dirty || !values.name.trim()}
              className="rounded-full bg-accent px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              {busy ? 'Saving…' : 'Save location'}
            </button>
            <button
              type="button"
              onClick={() => setValues(toForm(location))}
              disabled={busy || !dirty}
              className="rounded-full border border-sand-border bg-white/70 px-5 py-2.5 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:opacity-60"
            >
              Discard changes
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function toForm(location: StockLocation): LocationFormValues {
  return {
    name: location.name,
    kind: location.kind,
    isActive: location.is_active,
  };
}

function IconButton({
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
