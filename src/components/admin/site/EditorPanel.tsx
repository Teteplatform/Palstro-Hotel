import { useRef } from 'react';
import { FieldControl } from '../settings/FieldControl';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { CloseIcon } from '../../ui/icons';
import type { SettingsField, SettingsValues } from '../../../lib/settings/schema';
import type { SettingsMediaContext } from '../settings/mediaFieldContext';

// The editor side panel (3.txt §3): a panel (desktop, right) / bottom sheet
// (mobile) — never a modal, which would cover the very thing being edited. It
// renders the SAME build-3 FieldControl for each of the region's fields; it does
// NOT define its own field rendering, so a field looks and behaves identically to
// the form tabs. Non-image fields drive the live preview as the owner types (their
// values are lifted to SiteEditor); image fields persist immediately through the
// shared media context, exactly as on the settings tabs.

interface EditorPanelProps {
  label: string;
  fields: SettingsField[];
  // Draft values for the region's non-image fields (image fields bypass this and
  // commit on their own).
  values: SettingsValues;
  errors: Record<string, string>;
  onChange: (key: string, value: SettingsValues[string]) => void;
  onSave: () => void;
  saving: boolean;
  dirty: boolean;
  currency: string;
  mediaContext: SettingsMediaContext;
  // Ask to close. SiteEditor owns the unsaved-changes warning, so this may be
  // declined there; the panel just requests it (from the ✕, from Escape).
  onRequestClose: () => void;
}

export function EditorPanel({
  label,
  fields,
  values,
  errors,
  onChange,
  onSave,
  saving,
  dirty,
  currency,
  mediaContext,
  onRequestClose,
}: EditorPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Trap focus inside the panel and close on Escape (§3 + constraints). Reuses the
  // same hook as the admin nav drawer, so focus enters on open and returns to the
  // trigger on close.
  useFocusTrap(panelRef, true, onRequestClose);

  // Only non-image fields go through the "Save" button; image/imageList commit
  // instantly. A region with only images (e.g. Logo, Gallery) shows no Save row.
  const hasFormFields = fields.some(
    (f) => f.type !== 'image' && f.type !== 'imageList',
  );

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={`Edit ${label}`}
      className="fixed inset-x-0 bottom-0 z-40 flex h-[55vh] max-h-[85vh] flex-col rounded-t-2xl border-t border-sand-border bg-cream shadow-2xl md:inset-y-0 md:left-auto md:right-0 md:h-full md:max-h-none md:w-96 md:rounded-none md:border-l md:border-t-0"
    >
      <header className="flex items-center justify-between gap-3 border-b border-sand-border px-5 py-3.5">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wide text-charcoal-muted">
            Editing
          </p>
          <h2 className="truncate text-base font-semibold text-charcoal">
            {label}
          </h2>
        </div>
        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close editor"
          className="rounded-lg p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          <CloseIcon className="h-5 w-5" />
        </button>
      </header>

      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
        {fields.map((field) => (
          <FieldControl
            key={field.key}
            field={field}
            value={values[field.key]}
            onChange={(v) => onChange(field.key, v)}
            error={errors[field.key]}
            values={values}
            currency={currency}
            disabled={saving}
            mediaContext={mediaContext}
          />
        ))}

        {fields.some((f) => f.type === 'image' || f.type === 'imageList') ? (
          <p className="rounded-lg bg-sand/60 px-3 py-2 text-xs text-charcoal-muted">
            Image changes save as soon as you upload, remove or reorder.
          </p>
        ) : null}
      </div>

      {hasFormFields ? (
        <footer className="flex items-center justify-end gap-3 border-t border-sand-border px-5 py-3.5">
          {dirty ? (
            <span className="mr-auto text-xs text-charcoal-muted">
              Unsaved changes
            </span>
          ) : null}
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || saving}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? (
              <>
                <span
                  aria-hidden="true"
                  className="h-4 w-4 animate-spin rounded-full border-2 border-white/40 border-t-white"
                />
                Saving…
              </>
            ) : (
              'Save changes'
            )}
          </button>
        </footer>
      ) : null}
    </div>
  );
}
