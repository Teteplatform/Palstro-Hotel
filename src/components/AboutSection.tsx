import { Editable } from './Editable';

interface AboutSectionProps {
  text: string;
  image: string | null;
  hotelName: string;
}

// "About" — the property's story from branding.about_text, alongside
// branding.about_image. Rendered only when about_text exists (the caller gates
// on it); with no image it centers as a single readable column.
export function AboutSection({ text, image, hotelName }: AboutSectionProps) {
  return (
    <Editable fields={['about_text', 'about_image']} label="About">
    <section
      id="about"
      aria-labelledby="about-heading"
      className="scroll-mt-24 bg-sand/40 px-5 py-20 sm:px-8 lg:py-28"
    >
      <div className="mx-auto grid max-w-6xl items-center gap-10 lg:grid-cols-2 lg:gap-16">
        <div className={image ? '' : 'mx-auto max-w-2xl text-center'}>
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary">
            Welcome
          </p>
          <h2
            id="about-heading"
            className="text-3xl font-semibold text-charcoal sm:text-4xl"
          >
            About {hotelName}
          </h2>
          <p className="mt-5 whitespace-pre-line text-lg leading-relaxed text-charcoal-muted">
            {text}
          </p>
        </div>

        {image ? (
          <div className="overflow-hidden rounded-2xl">
            <img
              src={image}
              alt={hotelName}
              loading="lazy"
              className="h-full max-h-[28rem] w-full object-cover"
            />
          </div>
        ) : null}
      </div>
    </section>
    </Editable>
  );
}
