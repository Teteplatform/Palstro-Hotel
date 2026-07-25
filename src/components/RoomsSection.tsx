import { Link, useParams } from 'react-router-dom';
import type { RoomType } from '../types/room';
import {
  formatCurrency,
  formatOccupancy,
  firstImageUrl,
  parseNumeric,
} from '../lib/format';
import { mediaUrl, type MediaAssetMap } from '../lib/mediaUrl';
import { useEditMode } from '../hooks/useEditMode';
import { AnchorButton } from './ui/AnchorButton';
import { ArrowRightIcon } from './ui/icons';

// Resolve a room type's first image to a URL at the `card` variant — a room card
// is a mid-size tile, so card (800px) is the right size and full would be wasted
// egress (build 4 §3). room_types.images entries are media ids once the rooms
// module writes them; a value that is not a known id is treated as a legacy URL
// and passed through, so nothing breaks in the interim.
function resolveRoomImage(
  images: unknown,
  mediaMap: MediaAssetMap,
): string | null {
  const first = firstImageUrl(images);
  if (!first) return null;
  const asId = mediaUrl(mediaMap, first, 'card');
  if (asId) return asId;
  return first.includes('://') ? first : null;
}

// Where the room CTA and the header's Book Now both point for now: the contact
// section, so a guest can enquire by phone (the primary booking path in NG).
// When the booking module ships (phase 3) this becomes the booking flow with
// the room type preselected — the button label ("Enquire") changes to "Book".
const ENQUIRE_HREF = '#contact';

interface RoomsSectionProps {
  roomTypes: RoomType[];
  currency: string;
  loading: boolean;
  error: Error | null;
  // For resolving room image ids to URLs (build 4). Room images may be empty
  // today; this is wired for when the rooms module stores media ids.
  mediaMap: MediaAssetMap;
}

/**
 * "Rooms" section of the guest landing page. Reads room_types ONLY. Every
 * visible string, rate and image comes from the row — nothing tenant-specific
 * is written here (rule 17). Handles loading (skeletons), error (surfaced, not
 * swallowed), and zero rooms (a calm empty state) without breaking the layout.
 */
export function RoomsSection({
  roomTypes,
  currency,
  loading,
  error,
  mediaMap,
}: RoomsSectionProps) {
  return (
    <section
      id="rooms"
      aria-labelledby="rooms-heading"
      className="scroll-mt-24 bg-cream px-5 py-20 sm:px-8 lg:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <header className="mb-12 max-w-2xl">
          <p className="mb-2 text-sm font-semibold tracking-wide text-primary uppercase">
            Stay with us
          </p>
          <h2
            id="rooms-heading"
            className="text-3xl font-semibold text-charcoal sm:text-4xl"
          >
            Rooms &amp; Suites
          </h2>
        </header>

        {/* Rooms are NOT editable inline: room types are their own module (build
            5) with their own screen. Rather than dress the cards up as editable,
            the editor shows a clear link out to that screen. Only rendered inside
            the Site editor (isEditing), so the guest site is untouched. */}
        <EditRoomTypesLink />

        {error ? (
          <RoomsError message={error.message} />
        ) : loading ? (
          <RoomsGrid>
            {Array.from({ length: 3 }).map((_, i) => (
              <RoomCardSkeleton key={i} />
            ))}
          </RoomsGrid>
        ) : roomTypes.length === 0 ? (
          <RoomsEmpty />
        ) : (
          <RoomsGrid>
            {roomTypes.map((room) => (
              <RoomCard
                key={room.id}
                room={room}
                currency={currency}
                mediaMap={mediaMap}
              />
            ))}
          </RoomsGrid>
        )}
      </div>
    </section>
  );
}

// The "manage room types elsewhere" affordance shown only in the Site editor.
// Points at the rooms screen for the active property (build 5 will flesh it out);
// reads the slug from the route, which is only present under /admin/:propertySlug.
function EditRoomTypesLink() {
  const { isEditing } = useEditMode();
  const { propertySlug } = useParams();
  if (!isEditing || !propertySlug) return null;

  return (
    <div className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-primary/40 bg-primary/5 px-4 py-3">
      <p className="text-sm text-charcoal">
        Rooms are managed on their own screen, not edited here.
      </p>
      <Link
        to={`/admin/${propertySlug}/rooms`}
        className="inline-flex items-center gap-1.5 rounded-lg text-sm font-semibold text-primary hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
      >
        Edit room types
        <ArrowRightIcon className="h-4 w-4" />
      </Link>
    </div>
  );
}

function RoomsGrid({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {children}
    </div>
  );
}

function RoomCard({
  room,
  currency,
  mediaMap,
}: {
  room: RoomType;
  currency: string;
  mediaMap: MediaAssetMap;
}) {
  // Room card image at the `card` variant (build 4 §3), id or legacy URL.
  const image = resolveRoomImage(room.images, mediaMap);
  // size_sqm arrives as a numeric string ("25.00"); parse it so the display
  // reads "25 m²", not "25.00 m²", and so the guard tests a real number.
  const sizeSqm = parseNumeric(room.size_sqm);

  return (
    <article className="flex flex-col overflow-hidden rounded-2xl border border-sand-border bg-white/60">
      <div className="aspect-[4/3] w-full overflow-hidden bg-sand">
        {image ? (
          <img
            src={image}
            alt={room.name}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          // No usable image: a warm sand block, never a broken <img>.
          <div
            aria-hidden="true"
            className="flex h-full w-full items-center justify-center text-charcoal-muted"
          >
            <BedIcon className="h-10 w-10 opacity-40" />
          </div>
        )}
      </div>

      <div className="flex flex-1 flex-col p-6">
        <h3 className="text-xl font-semibold text-charcoal">{room.name}</h3>

        {room.description ? (
          <p className="mt-2 line-clamp-3 text-sm text-charcoal-muted">
            {room.description}
          </p>
        ) : null}

        <dl className="mt-4 space-y-2 text-sm text-charcoal">
          {room.bed_configuration ? (
            <div className="flex items-center gap-2">
              <BedIcon className="h-4 w-4 shrink-0 text-primary" />
              <dt className="sr-only">Beds</dt>
              <dd>{room.bed_configuration}</dd>
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <GuestsIcon className="h-4 w-4 shrink-0 text-primary" />
            <dt className="sr-only">Sleeps</dt>
            <dd>{formatOccupancy(room.max_adults, room.max_children)}</dd>
          </div>

          {sizeSqm != null ? (
            <div className="flex items-center gap-2">
              <AreaIcon className="h-4 w-4 shrink-0 text-primary" />
              <dt className="sr-only">Room size</dt>
              <dd>
                {sizeSqm} m<sup>2</sup>
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="mt-6 flex items-center justify-between gap-3 border-t border-sand-border pt-4">
          {/* The public "from" price is ALWAYS the RACK RATE (base_rate), never a
              weekend, seasonal, or company-negotiated rate (012 / build 5b). Dated
              and negotiated pricing is OPERATIONAL — resolve_room_rate and
              seasonal_rates have no public RLS policy precisely so they cannot
              reach the open web. Showing anything but base_rate here would leak
              that operational pricing to anonymous visitors. The admin rate
              preview (authenticated staff) is where resolved/dated rates are seen. */}
          <div className="flex items-baseline gap-1.5">
            <span className="text-xl font-bold text-charcoal">
              {formatCurrency(room.base_rate, currency)}
            </span>
            <span className="text-sm text-charcoal-muted">per night</span>
          </div>
          <AnchorButton
            href={ENQUIRE_HREF}
            aria-label={`Enquire about ${room.name}`}
          >
            Enquire
          </AnchorButton>
        </div>
      </div>
    </article>
  );
}

function RoomCardSkeleton() {
  return (
    <div
      className="flex animate-pulse flex-col overflow-hidden rounded-2xl border border-sand-border bg-white/60"
      aria-hidden="true"
    >
      <div className="aspect-[4/3] w-full bg-sand" />
      <div className="flex flex-1 flex-col p-6">
        <div className="h-5 w-2/3 rounded bg-sand" />
        <div className="mt-3 h-3 w-full rounded bg-sand" />
        <div className="mt-2 h-3 w-5/6 rounded bg-sand" />
        <div className="mt-6 h-4 w-1/3 rounded bg-sand" />
        <div className="mt-6 h-6 w-1/2 rounded bg-sand" />
      </div>
    </div>
  );
}

function RoomsEmpty() {
  return (
    <div className="rounded-2xl border border-dashed border-sand-border bg-sand/40 px-6 py-16 text-center">
      <p className="text-lg font-semibold text-charcoal">
        Room details are on their way
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm text-charcoal-muted">
        We’re updating our rooms right now. Please check back soon, or get in
        touch and we’ll be glad to help.
      </p>
    </div>
  );
}

function RoomsError({ message }: { message: string }) {
  // Rule 11: never swallow — the failure is shown, with the underlying message
  // available to anyone diagnosing it.
  return (
    <div
      role="alert"
      className="rounded-2xl border border-sand-border bg-sand/40 px-6 py-12 text-center"
    >
      <p className="text-lg font-semibold text-charcoal">
        We couldn’t load our rooms just now
      </p>
      <p className="mx-auto mt-2 max-w-md text-sm text-charcoal-muted">
        Please refresh the page to try again.
      </p>
      <p className="mt-3 text-xs text-charcoal-muted/80">{message}</p>
    </div>
  );
}

/* --- Decorative inline icons (aria-hidden; labels come from the data) ------ */

function BedIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8v10M3 12h18M21 12v6M3 18h18" />
      <path d="M7 12v-2a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v2" />
    </svg>
  );
}

function GuestsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20a6 6 0 0 1 12 0" />
      <path d="M16 6a3 3 0 0 1 0 6M21 20a6 6 0 0 0-4-5.6" />
    </svg>
  );
}

function AreaIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M8 4v3M4 8h3M16 20v-3M20 16h-3" />
    </svg>
  );
}
