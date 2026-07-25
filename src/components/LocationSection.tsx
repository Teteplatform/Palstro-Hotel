import { MapPinIcon, ArrowRightIcon } from './ui/icons';
import { parseNumeric } from '../lib/format';
import { osmEmbedSrc, osmDirectionsHref } from '../lib/osm';
import { Editable } from './Editable';

interface LocationSectionProps {
  hotelName: string;
  address: string | null;
  directions: string | null;
  latitude: string | number | null;
  longitude: string | number | null;
}

// The schema keys the Location editable region edits (3.txt §3): the postal
// address parts plus the two coordinate fields and their live map preview. Every
// key resolves in the settings schema (see tabs.ts contactFields).
const LOCATION_FIELD_KEYS = [
  'address_line',
  'city',
  'state',
  'postal_code',
  'latitude',
  'longitude',
  'location_map',
];

// Address (from the properties columns, 003) and, when present, directions (from
// branding, presentational), beside a real OpenStreetMap embed when the property
// has coordinates. The map is keyless — OSM's public embed iframe: no API key, no
// billing account, no third-party script. When either coordinate is absent we
// fall back to the marked placeholder rather than a broken or default-centred
// map. Caller renders this section only when there is an address.
export function LocationSection({
  hotelName,
  address,
  directions,
  latitude,
  longitude,
}: LocationSectionProps) {
  // Coordinates arrive as PostgREST numeric strings on the guest site, or as live
  // JS numbers when the site editor overlays an in-progress edit; parseNumeric
  // handles both. Either missing/unparseable/out-of-range -> no map, show the
  // placeholder. The bbox maths and range guards live in the shared osm helper so
  // the editor's live pin preview and this map can never disagree.
  const lat = parseNumeric(latitude);
  const lng = parseNumeric(longitude);
  const mapSrc = osmEmbedSrc(lat, lng);
  const directionsHref = osmDirectionsHref(lat, lng);
  const hasMap = mapSrc !== null;

  return (
    <Editable fields={LOCATION_FIELD_KEYS} label="Location">
    <section
      id="location"
      aria-labelledby="location-heading"
      className="scroll-mt-24 bg-cream px-5 py-20 sm:px-8 lg:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <header className="mb-12 max-w-2xl">
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary">
            Find us
          </p>
          <h2
            id="location-heading"
            className="text-3xl font-semibold text-charcoal sm:text-4xl"
          >
            Location
          </h2>
        </header>

        <div className="grid gap-8 lg:grid-cols-2 lg:gap-12">
          <div>
            {address ? (
              <div className="flex items-start gap-3">
                <MapPinIcon className="mt-1 h-6 w-6 shrink-0 text-primary" />
                <div>
                  <h3 className="text-sm font-semibold uppercase tracking-wide text-charcoal-muted">
                    Address
                  </h3>
                  <p className="mt-1 text-lg text-charcoal">{address}</p>
                </div>
              </div>
            ) : null}

            {directions ? (
              <div className="mt-6">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-charcoal-muted">
                  Getting here
                </h3>
                <p className="mt-1 whitespace-pre-line leading-relaxed text-charcoal-muted">
                  {directions}
                </p>
              </div>
            ) : null}
          </div>

          {hasMap ? (
            <div>
              {/* Rounded to match the room cards; overflow-hidden clips the
                  iframe's square corners. No hard border. */}
              <div className="overflow-hidden rounded-2xl">
                <iframe
                  title={`Map showing the location of ${hotelName}`}
                  src={mapSrc ?? undefined}
                  loading="lazy"
                  className="block h-[300px] w-full border-0 lg:h-[400px]"
                />
              </div>
              <a
                href={directionsHref ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 rounded text-sm font-semibold text-primary hover:text-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                Get directions
                <ArrowRightIcon className="h-4 w-4" />
              </a>
            </div>
          ) : (
            // No coordinates: keep the marked placeholder — never a broken or
            // default-centred map. Sized to match the map it stands in for.
            <div
              aria-hidden="true"
              className="flex min-h-[300px] items-center justify-center rounded-2xl border border-dashed border-sand-border bg-sand/40 text-center lg:min-h-[400px]"
            >
              <div className="px-6">
                <MapPinIcon className="mx-auto h-8 w-8 text-primary/60" />
                <p className="mt-2 text-sm font-medium text-charcoal-muted">
                  Map coming soon
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
    </Editable>
  );
}
