import { useState } from 'react';
import { Lightbox } from './Lightbox';
import { Editable } from './Editable';

// Each gallery image resolved to TWO URLs: `thumb` for the grid tile, `full` for
// the lightbox once opened (build 4 §3). The grid never loads the full variant —
// only the image a guest actually opens pays for it.
export interface GalleryImage {
  thumb: string;
  full: string;
}

interface GallerySectionProps {
  images: GalleryImage[];
  hotelName: string;
}

// Responsive image grid from branding.gallery_images (media ids resolved by the
// caller), each thumbnail a button that opens the lightbox at that image. Caller
// renders this only when there is at least one gallery image.
export function GallerySection({ images, hotelName }: GallerySectionProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  // Full-size URLs handed to the lightbox, in the same order as the grid.
  const fullImages = images.map((img) => img.full);

  return (
    <Editable fields={['gallery_images']} label="Gallery">
    <section
      id="gallery"
      aria-labelledby="gallery-heading"
      className="scroll-mt-24 bg-sand/40 px-5 py-20 sm:px-8 lg:py-28"
    >
      <div className="mx-auto max-w-6xl">
        <header className="mb-12 max-w-2xl">
          <p className="mb-2 text-sm font-semibold uppercase tracking-wide text-primary">
            Gallery
          </p>
          <h2
            id="gallery-heading"
            className="text-3xl font-semibold text-charcoal sm:text-4xl"
          >
            A look around
          </h2>
        </header>

        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {images.map((img, i) => (
            <li key={img.thumb}>
              <button
                type="button"
                onClick={() => setOpenIndex(i)}
                aria-label={`Open image ${i + 1} of ${images.length}`}
                className="group block aspect-square w-full overflow-hidden rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                <img
                  src={img.thumb}
                  alt={`${hotelName} — photo ${i + 1}`}
                  loading="lazy"
                  className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
                />
              </button>
            </li>
          ))}
        </ul>
      </div>

      {openIndex !== null ? (
        <Lightbox
          images={fullImages}
          startIndex={openIndex}
          hotelName={hotelName}
          onClose={() => setOpenIndex(null)}
        />
      ) : null}
    </section>
    </Editable>
  );
}
