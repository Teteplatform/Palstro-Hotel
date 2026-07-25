import { useEffect } from 'react';
import { usePropertyContext } from '../hooks/usePropertyContext';
import { useEditMode } from '../hooks/useEditMode';
import { useRoomTypes } from '../hooks/useRoomTypes';
import { usePropertyMedia } from '../hooks/usePropertyMedia';
import {
  brandingString,
  brandingStringArray,
  brandingRecord,
} from '../lib/branding';
import { mediaUrl, platformPlaceholder } from '../lib/mediaUrl';
import { applyBranding } from '../lib/theme';
import { formatPropertyAddress } from '../lib/address';
import { SiteHeader, type NavItem } from '../components/SiteHeader';
import { HeroCarousel } from '../components/HeroCarousel';
import { AboutSection } from '../components/AboutSection';
import { RoomsSection } from '../components/RoomsSection';
import { AmenitiesSection } from '../components/AmenitiesSection';
import { GallerySection } from '../components/GallerySection';
import { LocationSection } from '../components/LocationSection';
import { ContactFooter } from '../components/ContactFooter';

// The Enquire buttons and Book Now both point here for now (phone-first booking).
const BOOK_HREF = '#contact';

/**
 * Guest landing page. Every piece of content comes from the database: the hotel
 * name from property.name, everything else from property_settings.branding and
 * room_types. No tenant string is written into any component (rule 17).
 *
 * Each branding-driven section renders only when its data is present, so a
 * missing key leaves no empty gap. Rooms always renders (it has its own empty
 * state). Loading shows a skeleton, never a blank screen.
 */
export function LandingPage() {
  const { property, settings, loading, error } = usePropertyContext();
  // In the Site editor, optional sections must mount even when their content is
  // empty, so their empty-region placeholders can render (Editable owns that).
  // A guest has `isEditing` false, so each `|| isEditing` below collapses to the
  // original presence test and the public page is unchanged.
  const { isEditing } = useEditMode();
  const {
    roomTypes,
    loading: roomsLoading,
    error: roomsError,
  } = useRoomTypes(property?.id ?? null, property?.tenant_id ?? null);
  // Branding stores media_asset ids (009); resolve them to URLs at render time.
  // The map loads under the 010 public policy. While it loads, ids resolve to
  // null and the render layer falls back to the platform placeholder (009), so
  // the page is never blank or broken.
  const { map: mediaMap } = usePropertyMedia(
    property?.id ?? null,
    property?.tenant_id ?? null,
  );

  // Apply the property's branding to the CSS custom properties so a real visitor
  // sees this property's theme, not the platform default (build 3, §4). Missing
  // keys fall back to the defaults in index.css. Runs before the early returns so
  // the hook order stays stable.
  useEffect(() => {
    if (settings) applyBranding(settings.branding);
  }, [settings]);

  if (loading) return <LandingSkeleton />;
  if (error) return <LandingMessage title="Something went wrong" body={error.message} />;
  if (!property || !settings)
    return (
      <LandingMessage
        title="Site unavailable"
        body="No hotel is configured for this address."
      />
    );

  const b = settings.branding;
  const hotelName = property.name;

  const tagline = brandingString(b, 'tagline');
  const aboutText = brandingString(b, 'about_text');
  const amenities = brandingStringArray(b, 'amenities');

  // --- Image ids -> URLs, each at the variant the surface needs ---------------
  // The variant choice is the single biggest lever on egress cost, so it is
  // commented at every call site: a future change that quietly swaps a thumb for
  // a full would not otherwise announce itself.

  // Logo -> thumb: it renders at ~36px tall in the header; a larger variant is
  // pure waste on every page load.
  const logoUrl = mediaUrl(mediaMap, brandingString(b, 'logo_url'), 'thumb');

  // Hero -> full: a full-bleed background is the one place the 1920px variant is
  // justified. With none set, fall back to the platform placeholder so the hero
  // is a real image, not a flat colour (fallback in the render path, not data).
  const heroIds = brandingStringArray(b, 'hero_images');
  const resolvedHero = heroIds
    .map((id) => mediaUrl(mediaMap, id, 'full'))
    .filter((u): u is string => u !== null);
  const heroImages = resolvedHero.length > 0 ? resolvedHero : [platformPlaceholder];

  // About -> card: it sits in a half-width column, so card (800px) is ample and
  // full would be oversized.
  const aboutImage = mediaUrl(mediaMap, brandingString(b, 'about_image'), 'card');

  // Gallery -> thumb for the grid, full for the lightbox on open: the grid shows
  // small squares (thumb), and only the image a guest actually opens pays for the
  // full variant.
  const galleryImages = brandingStringArray(b, 'gallery_images')
    .map((id) => ({
      thumb: mediaUrl(mediaMap, id, 'thumb'),
      full: mediaUrl(mediaMap, id, 'full'),
    }))
    .filter(
      (img): img is { thumb: string; full: string } =>
        img.thumb !== null && img.full !== null,
    );
  // Address and contact come from the properties columns (003), not branding —
  // they are also what invoices, receipts and confirmations read. Only the
  // presentational bits (directions, social links) stay in branding.
  const address = formatPropertyAddress(property);
  const phone = property.phone?.trim() || null;
  const email = property.email?.trim() || null;
  const directions = brandingString(b, 'directions');
  const socials = brandingRecord(b, 'social');

  // Nav lists only the sections that will actually render, so a link never
  // jumps to a section that isn't on the page.
  const navItems = (
    [
      aboutText ? { id: 'about', label: 'About' } : null,
      { id: 'rooms', label: 'Rooms' },
      amenities.length ? { id: 'amenities', label: 'Amenities' } : null,
      galleryImages.length ? { id: 'gallery', label: 'Gallery' } : null,
      address ? { id: 'location', label: 'Location' } : null,
      { id: 'contact', label: 'Contact' },
    ] as (NavItem | null)[]
  ).filter((x): x is NavItem => x !== null);

  // The hero scroll cue points at the first section below it.
  const firstBelowHero = navItems[0]?.id ?? 'rooms';

  return (
    <>
      <SiteHeader
        hotelName={hotelName}
        logoUrl={logoUrl}
        navItems={navItems}
        bookHref={BOOK_HREF}
      />

      <main>
        <HeroCarousel
          hotelName={hotelName}
          tagline={tagline}
          images={heroImages}
          bookHref={BOOK_HREF}
          scrollCueHref={`#${firstBelowHero}`}
        />

        {aboutText || isEditing ? (
          <AboutSection
            text={aboutText ?? ''}
            image={aboutImage}
            hotelName={hotelName}
          />
        ) : null}

        <RoomsSection
          roomTypes={roomTypes}
          currency={property.currency}
          loading={roomsLoading}
          error={roomsError}
          mediaMap={mediaMap}
        />

        {amenities.length > 0 || isEditing ? (
          <AmenitiesSection amenities={amenities} />
        ) : null}

        {galleryImages.length > 0 || isEditing ? (
          <GallerySection images={galleryImages} hotelName={hotelName} />
        ) : null}

        {address ? (
          <LocationSection
            hotelName={hotelName}
            address={address}
            directions={directions}
            latitude={property.latitude}
            longitude={property.longitude}
          />
        ) : null}
      </main>

      <ContactFooter
        hotelName={hotelName}
        phone={phone}
        email={email}
        address={address}
        socials={socials}
        year={new Date().getFullYear()}
      />
    </>
  );
}

// A calm full-height placeholder while the property resolves — never a blank
// screen (accessibility + perceived performance).
function LandingSkeleton() {
  return (
    <div className="min-h-screen bg-cream" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading…</span>
      <div className="h-[100svh] min-h-[560px] w-full animate-pulse bg-sand" />
    </div>
  );
}

function LandingMessage({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-cream px-6">
      <div className="max-w-md text-center">
        <h1 className="text-2xl font-semibold text-charcoal">{title}</h1>
        <p className="mt-3 text-charcoal-muted">{body}</p>
      </div>
    </div>
  );
}
