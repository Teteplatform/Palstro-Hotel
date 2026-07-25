import { amenityIcon } from './ui/iconMap';
import { Editable } from './Editable';

interface AmenitiesSectionProps {
  amenities: string[];
}

// Icon + label grid from branding.amenities (an array of plain strings in the
// data). The label is always from the data; only the decorative icon is inferred
// from it. Caller renders this only when there is at least one amenity.
export function AmenitiesSection({ amenities }: AmenitiesSectionProps) {
  return (
    <Editable fields={['amenities']} label="Amenities">
    <section
      id="amenities"
      aria-labelledby="amenities-heading"
      className="scroll-mt-24 bg-cream px-5 py-20 sm:px-8 lg:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <header className="mb-12 max-w-2xl">
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary">
            What we offer
          </p>
          <h2
            id="amenities-heading"
            className="text-3xl font-semibold text-charcoal sm:text-4xl"
          >
            Amenities
          </h2>
        </header>

        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          {amenities.map((label) => {
            const Icon = amenityIcon(label);
            return (
              <li
                key={label}
                className="flex items-center gap-3 rounded-xl border border-sand-border bg-white/60 px-4 py-4"
              >
                <Icon className="h-6 w-6 shrink-0 text-primary" />
                <span className="text-sm font-medium text-charcoal">
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
    </Editable>
  );
}
