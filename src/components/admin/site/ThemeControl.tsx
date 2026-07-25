import { useEditMode } from '../../../hooks/useEditMode';
import { PaletteIcon } from '../../ui/icons';
import { THEME_FIELD_KEYS } from '../../../lib/settings/fieldIndex';

// The floating Theme control (3.txt §2). Colours and fonts apply to EVERYTHING
// and belong to no single section, so they are not a region on the page — they
// are this always-present button, which opens the same panel on the theme fields.
// It reads openEditor from EditMode context, so it only does anything inside the
// Site editor (where a provider supplies it).
export function ThemeControl() {
  const { openEditor } = useEditMode();

  return (
    <button
      type="button"
      onClick={() => openEditor(THEME_FIELD_KEYS, 'Theme')}
      className="fixed bottom-6 left-6 z-30 inline-flex items-center gap-2 rounded-full bg-charcoal px-4 py-3 text-sm font-semibold text-cream shadow-lg transition-colors hover:bg-charcoal/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream lg:left-[17.5rem]"
    >
      <PaletteIcon className="h-5 w-5" />
      Theme
    </button>
  );
}
