import { useEffect, useState } from 'react';
import { AnchorButton } from './ui/AnchorButton';
import { Editable } from './Editable';
import { MenuIcon, CloseIcon } from './ui/icons';

export interface NavItem {
  id: string;
  label: string;
}

interface SiteHeaderProps {
  hotelName: string;
  logoUrl: string | null;
  navItems: NavItem[];
  bookHref: string;
}

/**
 * Sticky header: transparent over the hero, solid (cream) once scrolled or when
 * the mobile menu is open. Logo comes from branding.logo_url; with none in the
 * data it falls back to the hotel name as text (never a hardcoded string —
 * hotelName is passed from property.name).
 */
export function SiteHeader({
  hotelName,
  logoUrl,
  navItems,
  bookHref,
}: SiteHeaderProps) {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const solid = scrolled || open;

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-colors duration-300 ${
        solid
          ? 'border-b border-sand-border bg-cream/95 shadow-sm backdrop-blur'
          : 'bg-transparent'
      }`}
    >
      <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-8">
        {/* Clicking the logo returns home — the convention every visitor
            expects; its absence reads as broken. Links to "/" (the site root),
            and the fallback name is wrapped too, so there is always a home
            target whether or not a logo is set. The link carries the accessible
            label (built from the property name, never the word "logo"), so the
            image is decorative (alt="") and screen readers announce the link
            once, not twice. */}
        {/* Editable region: the logo (branding.logo_url). On the guest site the
            Editable is a transparent pass-through, so this is exactly the same
            <a> as before. `noEmptyPlaceholder`: when no logo is set the header
            already shows the hotel name as a clickable fallback (below), so this
            region is never a dead empty slot — replacing that name with a "Add
            logo" box would remove real content from the header. */}
        <Editable fields={['logo']} label="Logo" noEmptyPlaceholder>
          <a
            href="/"
            aria-label={`${hotelName} — home`}
            className="flex items-center gap-2 rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-transparent"
          >
            {logoUrl ? (
              <img
                src={logoUrl}
                alt=""
                className="h-16 w-auto max-w-[200px] object-contain"
              />
            ) : (
              <span
                className={`text-lg font-bold tracking-tight ${
                  solid ? 'text-charcoal' : 'text-white'
                }`}
              >
                {hotelName}
              </span>
            )}
          </a>
        </Editable>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Primary">
          {navItems.map((it) => (
            <a
              key={it.id}
              href={`#${it.id}`}
              className={`rounded text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent ${
                solid
                  ? 'text-charcoal hover:text-primary focus-visible:ring-primary'
                  : 'text-white/90 hover:text-white focus-visible:ring-white'
              }`}
            >
              {it.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:block">
          <AnchorButton href={bookHref}>Book Now</AnchorButton>
        </div>

        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-controls="mobile-nav"
          className={`rounded p-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent md:hidden ${
            solid
              ? 'text-charcoal focus-visible:ring-primary'
              : 'text-white focus-visible:ring-white'
          }`}
        >
          <span className="sr-only">{open ? 'Close menu' : 'Open menu'}</span>
          {open ? (
            <CloseIcon className="h-6 w-6" />
          ) : (
            <MenuIcon className="h-6 w-6" />
          )}
        </button>
      </div>

      {open ? (
        <nav
          id="mobile-nav"
          aria-label="Primary"
          className="border-t border-sand-border bg-cream px-5 py-4 md:hidden"
        >
          <ul className="flex flex-col gap-1">
            {navItems.map((it) => (
              <li key={it.id}>
                <a
                  href={`#${it.id}`}
                  onClick={() => setOpen(false)}
                  className="block rounded-lg px-3 py-2.5 text-charcoal hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  {it.label}
                </a>
              </li>
            ))}
            <li className="pt-2">
              <AnchorButton
                href={bookHref}
                onClick={() => setOpen(false)}
                className="w-full"
              >
                Book Now
              </AnchorButton>
            </li>
          </ul>
        </nav>
      ) : null}
    </header>
  );
}
