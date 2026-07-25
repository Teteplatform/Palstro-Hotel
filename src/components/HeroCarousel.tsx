import { useEffect, useState } from 'react';
import { AnchorButton } from './ui/AnchorButton';
import { Editable } from './Editable';
import { useEditMode } from '../hooks/useEditMode';
import { ChevronDownIcon } from './ui/icons';

interface HeroCarouselProps {
  hotelName: string;
  tagline: string | null;
  images: string[];
  bookHref: string;
  scrollCueHref: string;
}

/**
 * Full-height hero. Degrades gracefully:
 *   - many images  -> slow crossfade carousel (paused for reduced-motion),
 *   - one image    -> a single static background,
 *   - no images    -> a solid warm background (bg-primary + scrim).
 * The hotel name is the page's single <h1>; the tagline sits beneath it.
 */
export function HeroCarousel({
  hotelName,
  tagline,
  images,
  bookHref,
  scrollCueHref,
}: HeroCarouselProps) {
  const count = images.length;
  const [index, setIndex] = useState(0);
  // In edit mode the tagline region must mount even when empty, so its "Add
  // tagline" placeholder can appear (a guest with `isEditing` false keeps the
  // original behaviour: no tagline, nothing rendered).
  const { isEditing } = useEditMode();

  useEffect(() => {
    if (count <= 1) return;
    const reduce = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    if (reduce) return;
    const id = window.setInterval(
      () => setIndex((i) => (i + 1) % count),
      6000,
    );
    return () => window.clearInterval(id);
  }, [count]);

  return (
    // The whole hero is the editable region for the hero images; the hotel name
    // and tagline are separate INNER regions (below) so the owner can click the
    // text itself. On the guest site every Editable is a pass-through, so the
    // markup is unchanged.
    <Editable fields={['hero_images']} label="Hero images" noEmptyPlaceholder>
    <section
      id="top"
      className="relative flex h-[100svh] min-h-[560px] items-center justify-center overflow-hidden bg-primary"
    >
      {images.map((src, i) => (
        <div
          key={src}
          aria-hidden="true"
          className={`absolute inset-0 transition-opacity duration-1000 ease-in-out ${
            i === index ? 'opacity-100' : 'opacity-0'
          }`}
        >
          {/* Decorative background: alt empty, the <h1> carries the name. Only
              the FIRST hero loads eagerly (it is what a visitor sees before the
              carousel advances); the rest are lazy, so a five-image hero does not
              pay for four `full` variants nobody may scroll to (3.txt §5). */}
          <img
            src={src}
            alt=""
            loading={i === 0 ? 'eager' : 'lazy'}
            fetchPriority={i === 0 ? 'high' : 'auto'}
            className="h-full w-full object-cover"
          />
        </div>
      ))}

      <div className="absolute inset-0 bg-charcoal/50" aria-hidden="true" />

      <div className="relative mx-auto max-w-3xl px-5 text-center text-white">
        <Editable fields={['name']} label="Hotel name">
          <h1 className="text-4xl font-bold leading-tight tracking-tight sm:text-5xl lg:text-6xl">
            {hotelName}
          </h1>
        </Editable>
        {tagline || isEditing ? (
          <Editable fields={['tagline']} label="Tagline">
            <p className="mx-auto mt-5 max-w-xl text-lg text-white/90 sm:text-xl">
              {tagline}
            </p>
          </Editable>
        ) : null}
        <div className="mt-8 flex justify-center">
          <AnchorButton href={bookHref} className="px-7 py-3 text-base">
            Book your stay
          </AnchorButton>
        </div>
      </div>

      {count > 1 ? (
        <div className="absolute bottom-20 left-1/2 flex -translate-x-1/2 gap-2">
          {images.map((_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => setIndex(i)}
              aria-label={`Show image ${i + 1} of ${count}`}
              aria-current={i === index}
              className={`h-2.5 rounded-full transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-transparent ${
                i === index ? 'w-6 bg-white' : 'w-2.5 bg-white/50 hover:bg-white/80'
              }`}
            />
          ))}
        </div>
      ) : null}

      <a
        href={scrollCueHref}
        aria-label="Scroll to content"
        className="absolute bottom-6 left-1/2 -translate-x-1/2 rounded-full p-1 text-white/80 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white motion-safe:animate-bounce"
      >
        <ChevronDownIcon className="h-6 w-6" />
      </a>
    </section>
    </Editable>
  );
}
