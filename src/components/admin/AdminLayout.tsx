import { useRef, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';
import { useTenantContext } from '../../hooks/useTenantContext';
import { useEnabledModules } from '../../hooks/useEnabledModules';
import { usePropertyLogo } from '../../hooks/usePropertyLogo';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ADMIN_NAV, ADMIN_NAV_GROUPS, type AdminNavItem } from './adminNav';
import { PropertySwitcher } from './PropertySwitcher';
import { UserMenu } from './UserMenu';
import { ChevronDownIcon, CloseIcon, MenuIcon } from '../ui/icons';
import { MISSING_VALUE } from '../../lib/format';
import { ADMIN_ROLES } from '../../types/auth';

// The admin shell (3.txt §2): persistent sidebar on desktop, slide-over drawer
// on mobile, a header carrying the tenant name / property switcher / user menu,
// and a content area that scrolls independently of the sidebar. Everything the
// bookings, housekeeping, F&B and accounting modules will hang off. Mobile-first
// — verified at 360px before desktop.
//
// The layout resolves the active property from the URL and renders one of three
// terminal states before the shell: loading, load-error, or a clear
// "not found / no access" message (NOT a redirect loop, per §1).

export function AdminLayout() {
  const { property, properties, loading, error, switchProperty } =
    useActiveProperty();
  const { memberships, tenantName } = useTenantContext();
  const [drawerOpen, setDrawerOpen] = useState(false);
  // The active property's logo (thumb) for the sidebar brand. Called before the
  // early returns to keep hook order stable; null ids (property still resolving)
  // resolve to no logo, so the brand falls back to the name text.
  const logoUrl = usePropertyLogo(
    property?.id ?? null,
    property?.tenant_id ?? null,
  );

  // Still resolving which properties this user may access.
  if (loading) {
    return <FullScreen busy label="Loading your properties…" />;
  }

  // The list itself failed to load — a real error, surfaced (rule 11), not a
  // blank shell.
  if (error) {
    return (
      <FullScreen>
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Something went wrong
          </h1>
          <p className="mt-3 text-charcoal-muted">
            We couldn't load your properties. Please refresh to try again.
          </p>
        </div>
      </FullScreen>
    );
  }

  // Slug present but not among the properties this user may operate — show a
  // clear message rather than bouncing between routes (§1).
  if (property === null) {
    return (
      <FullScreen>
        <div className="max-w-md text-center">
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Property not found
          </h1>
          <p className="mt-3 text-charcoal-muted">
            This property doesn't exist, or you do not have access to it. If you
            think this is a mistake, contact your hotel's administrator.
          </p>
        </div>
      </FullScreen>
    );
  }

  // The membership for the tenant that OWNS the active property — a multi-tenant
  // user's active property may not belong to their first membership, so neither
  // the tenant name nor the role may be taken from the tenant context's "active"
  // tenant. The approval PIN especially is keyed on (tenant_id, user_id), so
  // addressing the wrong tenant would set a PIN nobody can use.
  const owningMembership =
    memberships.find((m) => m.tenant_id === property.tenant_id) ?? null;
  const owningTenantName =
    owningMembership?.tenant?.name ?? tenantName ?? MISSING_VALUE;
  const canHoldManagerPin =
    owningMembership !== null && ADMIN_ROLES.includes(owningMembership.role);

  return (
    <div className="min-h-screen bg-cream">
      {/* Desktop sidebar: fixed so the main column scrolls independently.
          print:hidden — the admin chrome is navigation, and navigation on paper
          is wasted ink. The guest ledger's "Print statement" action (2.txt §3)
          relies on this: the page that prints is the statement alone, with no
          second renderer and therefore nothing that can disagree with what is
          on screen. */}
      <aside className="hidden print:hidden lg:fixed lg:inset-y-0 lg:left-0 lg:flex lg:w-64 lg:flex-col lg:border-r lg:border-sand-border lg:bg-sand/40">
        <SidebarBrand
          logoUrl={logoUrl}
          name={property.name}
          domain={property.domain}
        />
        <NavList slug={property.slug} />
      </aside>

      {/* Main column, offset for the fixed sidebar on desktop — and NOT offset
          when printing, since the sidebar is not there. */}
      <div className="lg:pl-64 print:pl-0">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-sand-border bg-cream/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-cream/80 sm:px-6 print:hidden">
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open navigation menu"
            aria-expanded={drawerOpen}
            className="rounded-lg border border-sand-border bg-white/70 p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream lg:hidden"
          >
            <MenuIcon className="h-5 w-5" />
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-xs text-charcoal-muted">Property</p>
            <p className="truncate text-sm font-semibold text-charcoal">
              {property.name}
              {/* Heledon's tenant and property share a name — showing both would
                  read as the same text twice. Only append the tenant when it
                  genuinely differs from the property (§3). */}
              {owningTenantName !== property.name ? (
                <span className="text-charcoal-muted"> · {owningTenantName}</span>
              ) : null}
            </p>
          </div>

          {/* Switcher only when there is a genuine choice (§1). */}
          {properties.length > 1 ? (
            <div className="w-44 sm:w-56">
              <PropertySwitcher
                property={property}
                properties={properties}
                onSwitch={switchProperty}
              />
            </div>
          ) : null}

          <UserMenu
            tenantId={property.tenant_id}
            canHoldManagerPin={canHoldManagerPin}
          />
        </header>

        <main className="px-4 py-6 sm:px-6 lg:px-8">
          <Outlet />
        </main>
      </div>

      {/* Mobile slide-over drawer. */}
      {drawerOpen ? (
        <MobileDrawer
          slug={property.slug}
          logoUrl={logoUrl}
          name={property.name}
          domain={property.domain}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SidebarBrand({
  logoUrl,
  name,
  domain,
}: {
  logoUrl: string | null;
  name: string;
  domain: string | null;
}) {
  return (
    <div className="flex h-16 items-center border-b border-sand-border px-5">
      <BrandLink logoUrl={logoUrl} name={name} domain={domain} />
    </div>
  );
}

// The active property's brand, linking to the LIVE GUEST SITE. Opens in a new tab
// on purpose: an admin clicking it wants to peek at their public site, not leave
// the admin (and lose any unsaved work) — so it opens a new tab, the label says
// so explicitly, and rel="noopener noreferrer" severs the new tab from this one.
// Renders the property logo when set, falling back to the property-name text
// otherwise, matching the guest header (SiteHeader). The image is decorative
// (alt="") because the link already carries the accessible label, and that same
// text fallback means a missing or dangling logo is never a broken image.
//
// The guest site is resolved by HOSTNAME, so the href must land on the property's
// own domain: a relative "/" is only correct when the admin happens to be served
// from that same domain. In production the admin is on the platform domain while
// each property has its own (properties.domain), so "/" there would resolve the
// wrong property or none. Build the absolute https://{domain} when a domain is
// set, and fall back to "/" only when it is null.
function BrandLink({
  logoUrl,
  name,
  domain,
}: {
  logoUrl: string | null;
  name: string;
  domain: string | null;
}) {
  const href = domain ? `https://${domain}` : '/';
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${name} — view live site (opens in a new tab)`}
      className="inline-flex min-w-0 items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
    >
      {logoUrl ? (
        <img
          src={logoUrl}
          alt=""
          className="h-16 w-auto max-w-[160px] object-contain"
        />
      ) : (
        <span className="truncate text-base font-bold tracking-tight text-charcoal">
          {name}
        </span>
      )}
    </a>
  );
}

// The navigation list, shared between the desktop sidebar and the mobile drawer
// so there is one source of nav markup. Built from ADMIN_NAV, grouped into the
// four sections of ADMIN_NAV_GROUPS. onNavigate lets the mobile drawer close
// itself when a link is followed (the desktop sidebar passes nothing, so it is a
// no-op there) — closing on the click avoids a route-watching effect.
//
// Items whose module the tenant has not enabled (006) are filtered out entirely,
// regardless of ready/coming_soon status; a group left empty by that filter is
// dropped so no heading ever sits over nothing.
//
// Each group is a native <details> (open by default): at 360px the full
// thirteen-item nav is long, so the user can collapse sections they are not
// using. Native <details> needs no JS state and no storage (constraint), stays
// keyboard- and screen-reader accessible, and behaves identically on desktop and
// in the mobile drawer.
function NavList({
  slug,
  onNavigate,
}: {
  slug: string;
  onNavigate?: () => void;
}) {
  const { isEnabled } = useEnabledModules();

  const groups = ADMIN_NAV_GROUPS.map((g) => ({
    ...g,
    items: ADMIN_NAV.filter(
      (item) => item.group === g.group && isEnabled(item.module),
    ),
  })).filter((g) => g.items.length > 0);

  return (
    <nav aria-label="Admin" className="flex-1 overflow-y-auto px-3 py-4">
      {groups.map((g) => (
        <details
          key={g.group}
          open
          className="group/nav mb-1"
        >
          <summary className="flex cursor-pointer list-none select-none items-center justify-between rounded-lg px-3 py-2 text-xs font-semibold uppercase tracking-wide text-charcoal-muted transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream [&::-webkit-details-marker]:hidden">
            <span>{g.label}</span>
            <ChevronDownIcon className="h-4 w-4 shrink-0 transition-transform group-open/nav:rotate-180" />
          </summary>
          <ul className="mt-1 space-y-1">
            {g.items.map((item) => (
              <li key={item.segment}>
                <NavItemLink slug={slug} item={item} onNavigate={onNavigate} />
              </li>
            ))}
          </ul>
        </details>
      ))}
    </nav>
  );
}

function NavItemLink({
  slug,
  item,
  onNavigate,
}: {
  slug: string;
  item: AdminNavItem;
  onNavigate?: () => void;
}) {
  const Icon = item.icon;

  // Coming-soon items are not links: visibly disabled, with a small badge, so
  // the owner sees the finished shape without a dead route (§2).
  if (item.status === 'coming_soon') {
    return (
      <span
        aria-disabled="true"
        className="flex cursor-not-allowed items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-charcoal-muted/70"
      >
        <Icon className="h-5 w-5 shrink-0" />
        <span className="flex-1">{item.label}</span>
        <span className="rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold tracking-wide text-charcoal-muted uppercase">
          Soon
        </span>
      </span>
    );
  }

  return (
    <NavLink
      to={`/admin/${slug}/${item.segment}`}
      onClick={onNavigate}
      className={({ isActive }) =>
        `flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream ${
          isActive
            ? 'bg-primary text-white'
            : 'text-charcoal hover:bg-sand'
        }`
      }
    >
      <Icon className="h-5 w-5 shrink-0" />
      <span>{item.label}</span>
    </NavLink>
  );
}

function MobileDrawer({
  slug,
  logoUrl,
  name,
  domain,
  onClose,
}: {
  slug: string;
  logoUrl: string | null;
  name: string;
  domain: string | null;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  // Trap focus inside the drawer and close on Escape (§2 accessibility).
  useFocusTrap(panelRef, true, onClose);

  return (
    <div className="fixed inset-0 z-40 lg:hidden">
      {/* Scrim: clicking it closes the drawer. aria-hidden — the labelled panel
          is the interactive surface. */}
      <button
        type="button"
        aria-label="Close navigation menu"
        onClick={onClose}
        className="absolute inset-0 bg-charcoal/40"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Admin navigation"
        className="absolute inset-y-0 left-0 flex w-72 max-w-[85%] flex-col bg-cream shadow-xl"
      >
        <div className="flex h-16 items-center justify-between border-b border-sand-border px-5">
          <BrandLink logoUrl={logoUrl} name={name} domain={domain} />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close navigation menu"
            className="rounded-lg p-2 text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </div>
        <NavList slug={slug} onNavigate={onClose} />
      </div>
    </div>
  );
}

// A neutral full-screen container for the layout's pre-shell states, matching
// ProtectedRoute's loader styling.
function FullScreen({
  children,
  busy,
  label,
}: {
  children?: React.ReactNode;
  busy?: boolean;
  label?: string;
}) {
  return (
    <div
      className="flex min-h-screen items-center justify-center bg-cream px-6"
      aria-busy={busy || undefined}
      aria-live={busy ? 'polite' : undefined}
    >
      {busy ? (
        <>
          <span className="sr-only">{label ?? 'Loading…'}</span>
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-sand-border border-t-primary" />
        </>
      ) : (
        children
      )}
    </div>
  );
}
