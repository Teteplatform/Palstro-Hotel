import { supabase } from '../supabase';
import type { SettingsPatches } from './values';
import type { SettingsRows } from './values';
import type {
  Property,
  PropertyFinanceSettings,
  PropertySettings,
  TenantSettings,
} from '../../types/tenant';

// The ONE write path for settings, factored out of SettingsForm so the inline
// Site editor (3.txt §3) saves through EXACTLY the same RPCs with the same
// optimistic-concurrency handling — "nothing about the write path changes". The
// order and updated_at threading mirror SettingsForm.handleSave verbatim:
//   - branding then config both write the property_settings row, so the second
//     must use the updated_at the first RETURNED, or it trips its own guard.
//   - properties and tenant each use their own row's token.
// Returns the fresh rows so the caller can swap them into its baseline without a
// refetch. Throws on the first RPC error (rule 11 — the caller awaits in
// try/catch and surfaces it); the custom SQLSTATEs (PT409/PT403) pass through for
// the caller to classify.

// The custom SQLSTATEs migration 008 raises (shared with SettingsForm).
export const SETTINGS_CONFLICT = 'PT409';
export const SETTINGS_FORBIDDEN = 'PT403';

async function callRpc<T>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export async function saveSettingsPatches(
  tenantId: string,
  propertyId: string,
  rows: SettingsRows,
  patches: SettingsPatches,
): Promise<Partial<SettingsRows>> {
  const applied: Partial<SettingsRows> = {};

  let psUpdatedAt = rows.settings.updated_at;
  if (patches.branding) {
    const row = await callRpc<PropertySettings>('update_property_branding', {
      p_property_id: propertyId,
      p_patch: patches.branding,
      p_expected_updated_at: psUpdatedAt,
    });
    psUpdatedAt = row.updated_at;
    applied.settings = row;
  }
  if (patches.config) {
    const row = await callRpc<PropertySettings>('update_property_config', {
      p_property_id: propertyId,
      p_patch: patches.config,
      p_expected_updated_at: psUpdatedAt,
    });
    applied.settings = row;
  }
  if (patches.properties) {
    const row = await callRpc<Property>('update_property_details', {
      p_property_id: propertyId,
      p_patch: patches.properties,
      p_expected_updated_at: rows.property.updated_at,
    });
    applied.property = row;
  }
  if (patches.tenant) {
    const row = await callRpc<TenantSettings>('update_tenant_settings', {
      p_tenant_id: tenantId,
      p_patch: patches.tenant,
      p_expected_updated_at: rows.tenant.updated_at,
    });
    applied.tenant = row;
  }
  // property_finance_settings (023 §3) — its own row, so its own updated_at
  // token; nothing else writes it, so there is no threading to do.
  if (patches.finance) {
    const row = await callRpc<PropertyFinanceSettings>(
      'update_property_finance_settings',
      {
        p_property_id: propertyId,
        p_patch: patches.finance,
        p_expected_updated_at: rows.finance.updated_at,
      },
    );
    applied.finance = row;
  }

  return applied;
}
