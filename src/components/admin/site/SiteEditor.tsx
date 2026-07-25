import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LandingPage } from '../../../pages/LandingPage';
import {
  PropertyContextValueProvider,
  type PropertyContextValue,
} from '../../../hooks/usePropertyContext';
import { EditModeContext, type EditModeValue } from '../../../hooks/useEditMode';
import { useSettingsData } from '../../../hooks/useSettingsData';
import { usePropertyMedia } from '../../../hooks/usePropertyMedia';
import { useDirtyForm } from '../../../hooks/useDirtyForm';
import { useToast } from '../../ui/Toast';
import { clearThemeOverrides } from '../../../lib/theme';
import { regionTab } from '../../../lib/settings/fieldIndex';
import {
  initialValues,
  changedFieldKeys,
  buildPatches,
} from '../../../lib/settings/values';
import { validateTab } from '../../../lib/settings/validate';
import { saveSettingsPatches } from '../../../lib/settings/save';
import { mediaErrorMessage } from '../settings/mediaFieldContext';
import type { SettingsMediaContext } from '../settings/mediaFieldContext';
import type { SettingsValues } from '../../../lib/settings/schema';
import type { PropertySettings } from '../../../types/tenant';
import { SettingsIcon } from '../../ui/icons';
import { EditorPanel } from './EditorPanel';
import { ThemeControl } from './ThemeControl';

// The inline visual editor (3.txt). It renders the REAL LandingPage — the exact
// guest components — with edit mode switched on, and previews edits live in the
// page as the owner types. There is no second landing page; the only difference
// from the public site is the two context providers wrapped around it here.
//
// DATA FLOW
//   - useSettingsData loads the active property's three rows (the same loader the
//     settings tabs use), giving the save baseline and its concurrency tokens.
//   - The open region's non-image field edits live in `draft`; `draft` is
//     overlaid onto the baseline to produce the EFFECTIVE property/settings fed to
//     PropertyContext, so LandingPage re-renders the change instantly (colours and
//     fonts included, via LandingPage's own applyBranding effect on the merged
//     branding). Image fields bypass `draft` and commit immediately, exactly as on
//     the settings tabs; a commit bumps `previewNonce` to remount LandingPage so
//     its own media map picks the new file up.
//   - Save writes through saveSettingsPatches — the SAME RPCs and updated_at
//     threading as the form. Nothing about the write path changes.

const DISCARD_MSG =
  'You have unsaved changes. Discard them?';

interface SiteEditorProps {
  propertyId: string;
  tenantId: string;
  slug: string;
}

export function SiteEditor({ propertyId, tenantId, slug }: SiteEditorProps) {
  const toast = useToast();
  const { rows, loading, error, applyRows } = useSettingsData(
    propertyId,
    tenantId,
  );
  const media = usePropertyMedia(propertyId, tenantId);
  const { markDirty, markClean } = useDirtyForm();

  // Which region's fields the panel is editing (schema keys + title), or null.
  const [open, setOpen] = useState<{ keys: string[]; label: string } | null>(
    null,
  );
  const [draft, setDraft] = useState<SettingsValues>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  // Bumped on an image commit so LandingPage remounts and re-pulls its media map.
  const [previewNonce, setPreviewNonce] = useState(0);

  const region = useMemo(
    () => (open ? regionTab(open.label, open.keys) : null),
    [open],
  );

  const dirty = useMemo(
    () =>
      region && rows
        ? changedFieldKeys(region, draft, rows).length > 0
        : false,
    [region, rows, draft],
  );

  // Drive the route/tab-close guard (useDirtyForm) from the real dirty state, so
  // navigating away from the editor with unsaved edits warns (§3 / constraints).
  useEffect(() => {
    if (dirty) markDirty();
    else markClean();
  }, [dirty, markDirty, markClean]);

  // On leaving the editor, drop any theme override LandingPage applied, so the
  // rest of the admin renders in the neutral platform theme (not this property's).
  useEffect(() => () => clearThemeOverrides(), []);

  // Keep the newest dirty/rows readable from the stable openEditor/close callbacks
  // without making them depend on (and churn with) every keystroke. The ref is
  // updated in an effect (never during render); openEditor/requestClose only run
  // from user events, which fire after the effect has committed, so it is current.
  const stateRef = useRef({ dirty, rows });
  useEffect(() => {
    stateRef.current = { dirty, rows };
  }, [dirty, rows]);

  const openEditor = useCallback((keys: string[], label: string) => {
    const { dirty, rows } = stateRef.current;
    if (!rows) return; // still loading — nothing to edit yet
    if (dirty && !window.confirm(DISCARD_MSG)) return;
    setOpen({ keys, label });
    setDraft(initialValues(regionTab(label, keys), rows));
    setErrors({});
  }, []);

  const requestClose = useCallback(() => {
    if (stateRef.current.dirty && !window.confirm(DISCARD_MSG)) return;
    setOpen(null);
    setDraft({});
    setErrors({});
  }, []);

  const editMode = useMemo<EditModeValue>(
    () => ({ isEditing: true, openEditor }),
    [openEditor],
  );

  function setField(key: string, value: SettingsValues[string]) {
    setDraft((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  // Media context for the panel's image fields — identical wiring to the settings
  // page. A branding commit (upload/remove/reorder) updates the baseline AND bumps
  // previewNonce so LandingPage remounts and its media map resolves the change.
  const mediaContext = useMemo<SettingsMediaContext>(
    () => ({
      tenantId,
      propertyId,
      branding: rows?.settings.branding ?? {},
      settingsUpdatedAt: rows?.settings.updated_at ?? '',
      assets: media.map,
      onBrandingCommitted: (row: PropertySettings) => {
        applyRows({ settings: row });
        setPreviewNonce((n) => n + 1);
      },
      reloadAssets: media.reload,
    }),
    [tenantId, propertyId, rows?.settings, media.map, media.reload, applyRows],
  );

  // The effective property/settings LandingPage renders: the baseline with the
  // open region's non-image draft overlaid. Memoised so its identity is stable
  // between keystrokes that don't change it (LandingPage's applyBranding effect
  // keys off settings identity).
  const effective = useMemo(() => {
    if (!rows) return { property: null, settings: null };
    if (!region) {
      return { property: rows.property, settings: rows.settings };
    }
    const changed = changedFieldKeys(region, draft, rows);
    const patches = buildPatches(region, draft, changed);
    const settings: PropertySettings = {
      ...rows.settings,
      branding: { ...rows.settings.branding, ...(patches.branding ?? {}) },
      ...(patches.config ?? {}),
    };
    const property = { ...rows.property, ...(patches.properties ?? {}) };
    return { property, settings };
  }, [rows, region, draft]);

  const ctxValue = useMemo<PropertyContextValue>(
    () => ({
      property: effective.property,
      settings: effective.settings,
      // LandingPage does not read tenant; the guest site never exposes it.
      tenant: null,
      loading,
      error,
    }),
    [effective, loading, error],
  );

  async function handleSave() {
    if (!region || !rows) return;
    const found = validateTab(region.fields, draft);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      toast.error('Please fix the highlighted fields before saving.');
      return;
    }
    setErrors({});

    const changed = changedFieldKeys(region, draft, rows);
    if (changed.length === 0) return;
    const patches = buildPatches(region, draft, changed);

    setSaving(true);
    try {
      const applied = await saveSettingsPatches(
        tenantId,
        propertyId,
        rows,
        patches,
      );
      applyRows(applied); // new baseline — dirty clears, preview stays put
      toast.success('Saved.');
    } catch (e) {
      toast.error(mediaErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <EditModeContext.Provider value={editMode}>
      {/* Break out of AdminLayout <main>'s padding (px-4 py-6 / sm / lg) so the
          guest site previews full-bleed, hero and all. */}
      <div className="relative -mx-4 -my-6 min-h-screen sm:-mx-6 lg:-mx-8">

        <EditorTopBar slug={slug} />

        {/* The preview shifts left when the desktop panel is open (content moves,
            never covered — §3). transform-gpu makes this box the containing block
            for LandingPage's position:fixed header, so the guest header sits at
            the top of the PREVIEW rather than floating over the admin chrome. */}
        <div
          className={`transition-[padding] duration-200 ${
            open ? 'md:pr-96' : ''
          }`}
        >
          <div className="transform-gpu">
            <PropertyContextValueProvider value={ctxValue}>
              <LandingPage key={previewNonce} />
            </PropertyContextValueProvider>
          </div>
        </div>

        <ThemeControl />

        {open && rows ? (
          <EditorPanel
            label={open.label}
            fields={region?.fields ?? []}
            values={draft}
            errors={errors}
            onChange={setField}
            onSave={() => void handleSave()}
            saving={saving}
            dirty={dirty}
            currency={rows.property.currency}
            mediaContext={mediaContext}
            onRequestClose={requestClose}
          />
        ) : null}
      </div>
    </EditModeContext.Provider>
  );
}

// The in-editor banner linking to the full settings list (§1, one direction of
// the two-way link). Some settings — VAT, timezone, night audit, online booking —
// have no visual counterpart to click, so the owner must always be one hop from
// the form.
function EditorTopBar({ slug }: { slug: string }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-sand-border bg-cream px-4 py-3 sm:px-6">
      <div>
        <h1 className="text-sm font-semibold text-charcoal">Site editor</h1>
        <p className="text-xs text-charcoal-muted">
          Click any highlighted area of your site to edit it. Changes preview
          here and save per section.
        </p>
      </div>
      <Link
        to={`/admin/${slug}/settings`}
        className="inline-flex items-center gap-2 rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        <SettingsIcon className="h-4 w-4" />
        All settings
      </Link>
    </div>
  );
}
