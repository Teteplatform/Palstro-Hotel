import { useEffect, useMemo, useState } from 'react';
import { supabase } from '../../../lib/supabase';
import { useToast } from '../../ui/Toast';
import { useDirtyForm } from '../../../hooks/useDirtyForm';
import type { SettingsTab, SettingsValues } from '../../../lib/settings/schema';
import {
  brandingPreviewFrom,
  buildPatches,
  changedFieldKeys,
  initialValues,
  type SettingsRows,
} from '../../../lib/settings/values';
import { validateTab } from '../../../lib/settings/validate';
import { applyBranding, clearThemeOverrides } from '../../../lib/theme';
import { FieldControl } from './FieldControl';
import type { SettingsMediaContext } from './mediaFieldContext';
import type { MediaAssetMap } from '../../../lib/mediaUrl';
import type {
  Property,
  PropertyFinanceSettings,
  PropertySettings,
  TenantSettings,
} from '../../../types/tenant';

// The generic settings form (build 3, §3). Renders ANY tab from its schema —
// there is not a single field-specific branch here; every per-type decision
// lives in FieldControl. Save is per tab: it splits the changed values by their
// storage target and calls the matching migration-008 RPC for each, passing the
// updated_at it loaded with so a stale write is rejected rather than clobbering.

interface SettingsFormProps {
  tab: SettingsTab;
  // The three rows loaded once by the page. Acts as the save BASELINE: as each
  // RPC succeeds, the page swaps in the returned row, so a saved field goes
  // clean while an un-saved one keeps the admin's typing.
  rows: SettingsRows;
  tenantId: string;
  propertyId: string;
  // Called with the fresh row(s) after each successful RPC so the page updates
  // the baseline (and its concurrency tokens) without a refetch.
  onSaved: (patch: Partial<SettingsRows>) => void;
  // Reports dirty state up so the page can warn before a tab switch.
  onDirtyChange: (dirty: boolean) => void;
  // The property's live media (id -> asset), loaded once by the page, for the
  // image renderers to resolve stored ids to URLs. reloadMedia re-pulls it after
  // an upload/delete.
  mediaAssets: MediaAssetMap;
  reloadMedia: () => Promise<void>;
}

// The custom SQLSTATEs migration 008 raises.
const CONFLICT = 'PT409';
const FORBIDDEN = 'PT403';

export function SettingsForm({
  tab,
  rows,
  tenantId,
  propertyId,
  onSaved,
  onDirtyChange,
  mediaAssets,
  reloadMedia,
}: SettingsFormProps) {
  const toast = useToast();
  const { markDirty, markClean } = useDirtyForm();

  // Media context for the image renderers. Rebuilt whenever the baseline settings
  // row or the loaded assets change, so branding and the concurrency token it
  // hands each commit are always the freshest — a text Save and an image commit
  // thread the same updated_at through each other correctly.
  const mediaContext = useMemo<SettingsMediaContext>(
    () => ({
      tenantId,
      propertyId,
      branding: rows.settings.branding,
      settingsUpdatedAt: rows.settings.updated_at,
      assets: mediaAssets,
      onBrandingCommitted: (row) => onSaved({ settings: row }),
      reloadAssets: reloadMedia,
    }),
    [tenantId, propertyId, rows.settings, mediaAssets, onSaved, reloadMedia],
  );

  // Field values, seeded once from the loaded rows. Deliberately NOT re-seeded
  // when `rows` later changes (after a save) — that would discard the admin's
  // in-progress typing on any field that did not save. Baseline comparison uses
  // the live `rows` instead.
  const [values, setValues] = useState<SettingsValues>(() =>
    initialValues(tab, rows),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const changed = useMemo(
    () => changedFieldKeys(tab, values, rows),
    [tab, values, rows],
  );
  const dirty = changed.length > 0;

  // Drive the route/tab-close guard and the page's tab-switch guard from the
  // real dirty state.
  useEffect(() => {
    if (dirty) markDirty();
    else markClean();
  }, [dirty, markDirty, markClean]);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  // Live theme preview (§4): while a tab carries colour/font fields, mirror the
  // live values onto the document root so the admin sees the change as they
  // type. Clear the overrides when leaving, so the rest of the admin renders in
  // the neutral platform theme.
  const hasThemePreview = useMemo(
    () => tab.fields.some((f) => f.type === 'color' || f.type === 'font'),
    [tab],
  );
  useEffect(() => {
    if (!hasThemePreview) return;
    applyBranding(brandingPreviewFrom(tab, values));
    return () => clearThemeOverrides();
  }, [hasThemePreview, tab, values]);

  function setField(key: string, value: SettingsValues[string]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear a field's error the moment it is edited.
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  async function callRpc<T>(
    fn: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) throw error;
    return data as T;
  }

  async function handleSave() {
    // Validate first — an invalid field blocks the save and shows its error (§3).
    const found = validateTab(tab.fields, values);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error('Please fix the highlighted fields before saving.');
      return;
    }
    setErrors({});

    if (!dirty) return;
    const patches = buildPatches(tab, values, changed);

    setSaving(true);
    try {
      // property_settings row: branding first, then columns, THREADING the
      // returned updated_at — both write the same row, so the second must use
      // the token the first produced or it would trip its own concurrency check.
      let psUpdatedAt = rows.settings.updated_at;
      if (patches.branding) {
        const row = await callRpc<PropertySettings>('update_property_branding', {
          p_property_id: propertyId,
          p_patch: patches.branding,
          p_expected_updated_at: psUpdatedAt,
        });
        psUpdatedAt = row.updated_at;
        onSaved({ settings: row });
      }
      if (patches.config) {
        const row = await callRpc<PropertySettings>('update_property_config', {
          p_property_id: propertyId,
          p_patch: patches.config,
          p_expected_updated_at: psUpdatedAt,
        });
        onSaved({ settings: row });
      }
      if (patches.properties) {
        const row = await callRpc<Property>('update_property_details', {
          p_property_id: propertyId,
          p_patch: patches.properties,
          p_expected_updated_at: rows.property.updated_at,
        });
        onSaved({ property: row });
      }
      if (patches.tenant) {
        const row = await callRpc<TenantSettings>('update_tenant_settings', {
          p_tenant_id: tenantId,
          p_patch: patches.tenant,
          p_expected_updated_at: rows.tenant.updated_at,
        });
        onSaved({ tenant: row });
      }
      // property_finance_settings (023 §3): its own row, its own token.
      if (patches.finance) {
        const row = await callRpc<PropertyFinanceSettings>(
          'update_property_finance_settings',
          {
            p_property_id: propertyId,
            p_patch: patches.finance,
            p_expected_updated_at: rows.finance.updated_at,
          },
        );
        onSaved({ finance: row });
      }

      toast.success('Settings saved.');
    } catch (e) {
      handleSaveError(e);
    } finally {
      setSaving(false);
    }
  }

  function handleSaveError(e: unknown) {
    const err = e as { code?: string; message?: string };
    if (err?.code === CONFLICT) {
      // Do NOT auto-reload or discard the admin's typing (§3). Tell them, and
      // leave their edits in place to reapply after they reload.
      toast.error(
        'Someone else changed these settings while you were editing. ' +
          'Reload to see their changes, then reapply yours.',
      );
    } else if (err?.code === FORBIDDEN) {
      toast.error('You do not have permission to change these settings.');
    } else {
      toast.error(err?.message || 'Could not save settings. Please try again.');
    }
  }

  return (
    <section aria-labelledby={`tab-${tab.id}-heading`}>
      <header className="mb-6">
        <h2
          id={`tab-${tab.id}-heading`}
          className="text-lg font-semibold text-charcoal"
        >
          {tab.label}
        </h2>
        {tab.description ? (
          <p className="mt-1 text-sm text-charcoal-muted">{tab.description}</p>
        ) : null}
      </header>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleSave();
        }}
        className="space-y-6"
      >
        <div className="space-y-5 rounded-2xl border border-sand-border bg-white/60 p-5 sm:p-6">
          {tab.fields.map((field) => (
            <FieldControl
              key={field.key}
              field={field}
              value={values[field.key]}
              onChange={(v) => setField(field.key, v)}
              error={errors[field.key]}
              values={values}
              currency={rows.property.currency}
              disabled={saving}
              mediaContext={mediaContext}
            />
          ))}
        </div>

        {/* Save is per tab, disabled when clean, with a saving state (§3). */}
        <div className="flex items-center justify-end gap-3">
          {dirty ? (
            <span className="text-xs text-charcoal-muted">Unsaved changes</span>
          ) : null}
          <button
            type="submit"
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
        </div>
      </form>
    </section>
  );
}
