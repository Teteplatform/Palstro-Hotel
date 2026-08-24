import { useCallback, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useTenantContext } from '../../hooks/useTenantContext';
import { useSettingsData } from '../../hooks/useSettingsData';
import { usePropertyMedia } from '../../hooks/usePropertyMedia';
import { SETTINGS_TABS } from '../../lib/settings/tabs';
import { canHoldManagerPin } from '../../lib/managerPin';
import { isTenantAdminMember } from '../../lib/tenantRole';
import { SettingsForm } from '../../components/admin/settings/SettingsForm';
import { OrphanCleanup } from '../../components/admin/settings/OrphanCleanup';
import { ManagerPinPanel } from '../../components/admin/ManagerPinPanel';
import { AccountsScreen } from '../../components/admin/settings/AccountsScreen';
import { SiteIcon } from '../../components/ui/icons';
import type { SettingsRows } from '../../lib/settings/values';

// The settings screen (build 3, §5) — replaces the build-1 placeholder. Tabs
// come from tabs.ts; the active tab lives in the URL as ?tab=<id> so a reload or
// a shared link returns to the same tab. Mobile-first: at 360px the tab strip
// scrolls horizontally rather than wrapping into an unusable stack. Switching
// tabs with unsaved changes warns first.
//
// THE MANAGER PIN TAB IS NOT A SETTINGS_TABS ENTRY, and that is deliberate.
// SETTINGS_TABS drives the generic form engine: a list of FIELDS, loaded from and
// saved to property_settings / tenant_settings rows. A PIN is none of those
// things — it is write-only, it is per-USER rather than per-property, it never
// loads a current value, and it is saved by a SECURITY DEFINER RPC that hashes
// it. Modelling it as a field would mean teaching the form engine about a value
// it must never read back, which is exactly the kind of exception that turns a
// small engine into a large one. It is a tab in the STRIP and its own panel
// underneath; nothing else about the engine changes.
const MANAGER_PIN_TAB = { id: 'manager-pin', label: 'Manager PIN' } as const;

// THE ACCOUNTS TAB IS NOT A SETTINGS_TABS ENTRY EITHER, for the same reason the
// PIN tab is not: SETTINGS_TABS drives the generic form engine, which loads and
// saves FIELDS on a property_settings / tenant_settings row. The account
// mappings are neither — they are many rows in their own table, each edited on
// its own line, with a derived column the engine has no concept of. Modelling
// them as fields would mean teaching the form engine about a repeating row set,
// which is exactly the kind of exception that turns a small engine into a large
// one. A tab in the STRIP, its own panel underneath, and nothing else changes.
//
// ADMIN ONLY. Pointing revenue at the wrong account is not a mistake a front
// desk should be able to make by wandering into settings — and 044's
// is_tenant_admin() policies would refuse the write anyway, so offering the
// control to anyone else is offering a control that only ever fails (rule 19:
// this hides it, the policy is the guard).
const ACCOUNTS_TAB = { id: 'accounts', label: 'Accounts' } as const;

export function SettingsPage() {
  const { property } = useActiveProperty();
  const { memberships } = useTenantContext();
  const [searchParams, setSearchParams] = useSearchParams();

  // AdminLayout only renders this once `property` is resolved; guard anyway.
  if (!property) return null;

  return (
    // Keyed by property so switching property tears down and reloads cleanly —
    // no stale rows or dirty flags bleed across properties.
    <SettingsScreen
      key={property.id}
      propertyId={property.id}
      tenantId={property.tenant_id}
      slug={property.slug}
      // Owners and managers of the tenant that OWNS this property only. Front
      // desk, housekeeping and kitchen accounts are not offered the tab, because
      // set_manager_pin would refuse them anyway (rule 19: this hides a control,
      // the RPC is the guard). Same test as the user menu — lib/managerPin.
      showManagerPin={canHoldManagerPin(memberships, property.tenant_id)}
      showAccounts={isTenantAdminMember(memberships, property.tenant_id)}
      searchParams={searchParams}
      setSearchParams={setSearchParams}
    />
  );
}

function SettingsScreen({
  propertyId,
  tenantId,
  slug,
  showManagerPin,
  showAccounts,
  searchParams,
  setSearchParams,
}: {
  propertyId: string;
  tenantId: string;
  slug: string;
  showManagerPin: boolean;
  showAccounts: boolean;
  searchParams: URLSearchParams;
  setSearchParams: ReturnType<typeof useSearchParams>[1];
}) {
  const { rows, loading, error, applyRows, reload } = useSettingsData(
    propertyId,
    tenantId,
  );
  // The property's live media, loaded once for the whole screen: the image
  // renderers resolve ids through it, and the orphan panel scans it. reload() is
  // called after any upload/delete so both stay current.
  const media = usePropertyMedia(propertyId, tenantId);

  // Resolve the active tab from the URL, falling back to the first for an
  // absent/unknown value. The Manager PIN tab is resolved separately because it
  // is not a form tab (see MANAGER_PIN_TAB) — and a user who is NOT an
  // owner/manager falls back to the first form tab even if the URL names it, so
  // a shared link cannot put a front-desk user in front of a control that would
  // only ever reject them.
  const paramTab = searchParams.get('tab');
  const pinTabActive = showManagerPin && paramTab === MANAGER_PIN_TAB.id;
  // Same fallback rule as the PIN tab: a non-admin who follows a shared link
  // naming this tab lands on the first form tab instead, so nobody is put in
  // front of a control that would only ever reject them.
  const accountsTabActive = showAccounts && paramTab === ACCOUNTS_TAB.id;
  const activeTab =
    SETTINGS_TABS.find((t) => t.id === paramTab) ?? SETTINGS_TABS[0];
  // What the tab strip highlights: the PIN or Accounts tab when one is active,
  // else the form tab. One value so the strip cannot show two selected tabs.
  const activeTabId = pinTabActive
    ? MANAGER_PIN_TAB.id
    : accountsTabActive
      ? ACCOUNTS_TAB.id
      : activeTab.id;
  const tabStrip: { id: string; label: string }[] = [
    ...SETTINGS_TABS.map((t) => ({ id: t.id, label: t.label })),
    ...(showAccounts ? [ACCOUNTS_TAB] : []),
    ...(showManagerPin ? [MANAGER_PIN_TAB] : []),
  ];

  // Latest dirty flag from the mounted form, read synchronously in the tab-switch
  // handler (a ref, so reporting it does not re-render the whole page).
  const dirtyRef = useRef(false);
  const onDirtyChange = useCallback((dirty: boolean) => {
    dirtyRef.current = dirty;
  }, []);

  const onSaved = useCallback(
    (patch: Partial<SettingsRows>) => applyRows(patch),
    [applyRows],
  );

  function selectTab(id: string) {
    if (id === activeTabId) return;
    if (
      dirtyRef.current &&
      !window.confirm(
        'You have unsaved changes on this tab. Discard them and switch?',
      )
    ) {
      return;
    }
    dirtyRef.current = false;
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('tab', id);
        return next;
      },
      { replace: true },
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Settings
          </h1>
          <p className="mt-1 text-sm text-charcoal-muted">
            Configure how this property looks and operates.
          </p>
        </div>
        {/* Two-way link to the visual editor (§1): the owner who would rather
            click the site than scan a form is one hop away. */}
        <Link
          to={`/admin/${slug}/site`}
          className="inline-flex items-center gap-2 rounded-lg border border-sand-border bg-white/70 px-3 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
        >
          <SiteIcon className="h-4 w-4" />
          Edit visually
        </Link>
      </header>

      {/* Tab strip — horizontally scrollable on narrow screens. */}
      <div
        role="tablist"
        aria-label="Settings sections"
        className="-mx-4 mb-6 flex gap-1 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-0"
      >
        {tabStrip.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(tab.id)}
              className={`shrink-0 whitespace-nowrap rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
                active
                  ? 'bg-primary text-white'
                  : 'text-charcoal hover:bg-sand'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* The Manager PIN tab renders on its own: it reads no settings rows and
          writes none, so it is deliberately OUTSIDE the loading/error branch
          below — a settings-load failure must not hide the control a manager
          needs in order to approve a reversal at the desk. */}
      {accountsTabActive ? (
        // Outside the loading/error branch for the same reason the PIN tab is:
        // it reads none of the settings rows, so a settings-load failure has no
        // business hiding the chart of accounts.
        <section className="rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
          <AccountsScreen
            tenantId={tenantId}
            propertyId={propertyId}
            propertySlug={slug}
            canEdit
          />
        </section>
      ) : pinTabActive ? (
        <section className="rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
          <h2 className="text-lg font-bold tracking-tight text-charcoal">
            Manager PIN
          </h2>
          <p className="mt-1 mb-4 text-sm text-charcoal-muted">
            Your own approval PIN for this hotel group. It is personal to you —
            nobody, including the owner, can set or read another person's PIN.
          </p>
          <ManagerPinPanel tenantId={tenantId} />
        </section>
      ) : loading ? (
        <LoadingState />
      ) : error ? (
        <ErrorState message={error.message} onRetry={reload} />
      ) : rows ? (
        <>
          <SettingsForm
            // Remount on tab change so each tab gets fresh, isolated form state.
            key={activeTab.id}
            tab={activeTab}
            rows={rows}
            tenantId={tenantId}
            propertyId={propertyId}
            onSaved={onSaved}
            onDirtyChange={onDirtyChange}
            mediaAssets={media.map}
            reloadMedia={media.reload}
          />

          {/* Orphan cleanup is property-wide, not per-tab: it lists media no
              branding key or room type still references. Fed the live branding
              (so it reflects image edits made above) and the shared media list. */}
          <OrphanCleanup
            propertyId={propertyId}
            tenantId={tenantId}
            branding={rows.settings.branding}
            assets={media.assets}
            reloadMedia={media.reload}
          />
        </>
      ) : null}
    </div>
  );
}

function LoadingState() {
  return (
    <div
      className="flex items-center justify-center rounded-2xl border border-sand-border bg-white/60 py-16"
      aria-busy="true"
      aria-live="polite"
    >
      <span className="sr-only">Loading settings…</span>
      <span className="h-7 w-7 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  return (
    <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center">
      <p className="text-sm font-medium text-charcoal">
        We couldn’t load these settings.
      </p>
      <p className="mt-1 text-sm text-charcoal-muted">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-4 inline-flex items-center rounded-lg border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
      >
        Try again
      </button>
    </div>
  );
}
