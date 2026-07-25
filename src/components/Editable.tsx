import type { ReactNode } from 'react';
import { useEditMode } from '../hooks/useEditMode';
import { usePropertyContext } from '../hooks/usePropertyContext';
import { brandingString, brandingStringArray } from '../lib/branding';
import { fieldsForKeys } from '../lib/settings/fieldIndex';
import type { SettingsField } from '../lib/settings/schema';
import type { Property, PropertyBranding } from '../types/tenant';
import { EditIcon, PlusIcon } from './ui/icons';

interface EditableProps {
  // The schema field key(s) this region edits (e.g. ['about_text','about_image']).
  // Looked up in the existing settings schema by the panel — the field controls
  // are the build-3 controls, never re-implemented here.
  fields: string[];
  // Human label for the region and the panel title (e.g. "About").
  label: string;
  children: ReactNode;
  // Optional extra classes on the edit-mode wrapper (never rendered on the guest
  // site, where there is no wrapper at all).
  className?: string;
  // Opt OUT of the empty-state placeholder: keep rendering children even when the
  // region's value is empty. For a region whose children carry OTHER always-present
  // content the placeholder must not swallow — the Hero wraps hero_images but also
  // holds the hotel name, tagline and the Book CTA, so replacing it with a small
  // "Add hero images" box would delete all of that. Such a region is already a
  // click target when empty (it renders its own fallback), so it needs no
  // placeholder.
  noEmptyPlaceholder?: boolean;
}

// Is one field's stored value empty? Mirrors the schema's own empty semantics:
// a list field is empty when it has no ids/strings; a branding string when unset;
// a properties column when null or blank. Kept local so this file stays the one
// place the editor's empty-state logic lives (3.txt).
function isFieldEmpty(
  field: SettingsField,
  property: Property,
  branding: PropertyBranding,
): boolean {
  const s = field.storage;
  if (s.target === 'branding') {
    if (field.type === 'imageList' || field.type === 'stringList') {
      return brandingStringArray(branding, s.brandingKey).length === 0;
    }
    return brandingString(branding, s.brandingKey) === null;
  }
  if (s.target === 'properties') {
    const v = (property as unknown as Record<string, unknown>)[s.column];
    return v == null || (typeof v === 'string' && v.trim() === '');
  }
  // property_settings / tenant_settings targets are never used by an on-page
  // region; treat them as non-empty so they never trigger a placeholder.
  return false;
}

// A placeholder sized ROUGHLY to the content that belongs there, keyed off the
// region's field types: image/gallery regions get a tall box, a paragraph gets a
// medium one, a single line gets a short one.
function placeholderHeight(defs: SettingsField[]): string {
  const types = new Set(defs.map((d) => d.type));
  if (types.has('imageList') || types.has('image')) return 'min-h-40';
  if (types.has('textarea') || types.has('stringList')) return 'min-h-28';
  return 'min-h-16';
}

/**
 * Wraps one editable piece of the guest site. It is the ONLY thing that changes
 * between the public site and the editor:
 *
 *   - `isEditing` false (the public site — no EditMode provider is mounted):
 *     returns the children in a fragment. No wrapper element, no listeners, no
 *     placeholder. The rendered markup is byte-for-byte what it was before this
 *     build, so an anonymous visitor sees and downloads nothing extra (§4).
 *
 *   - `isEditing` true (inside the admin Site editor): wraps filled content in a
 *     hover-outlined region with a corner "Edit" affordance; and when the region's
 *     value is EMPTY, renders a click-to-add placeholder in its place instead of
 *     nothing.
 *
 * WHY THE PLACEHOLDER EXISTS — do not mistake it for decoration. When a region's
 * value is empty the page renders nothing there, so there is nothing to click.
 * That is not an edge case: it is the state of EVERY field on a newly created
 * property, so without this the visual editor is least usable exactly during
 * first-time setup — the first thing a new customer sees. The placeholder gives
 * every empty region a labelled click target that opens the same panel the filled
 * state does.
 *
 * The placeholder is gated on `isEditing`, so a guest is never shown it: on the
 * public site the first line below returns before any of this runs.
 *
 * Nesting works (the Hero region contains the hotel-name and tagline regions):
 * a click is handled on the BUBBLE phase and stopped, so the innermost region
 * wins and the outer one does not also fire. preventDefault keeps a click in the
 * live preview from following a link or activating a control instead of editing.
 */
export function Editable({
  fields,
  label,
  children,
  className,
  noEmptyPlaceholder,
}: EditableProps) {
  const { isEditing, openEditor } = useEditMode();
  // Read the live values so the region knows whether it is empty. On the guest
  // site this hook still runs, but we return above before using it — and it is a
  // context read, never a fetch, so the public site makes no extra request.
  const { property, settings } = usePropertyContext();

  // The load-bearing line: on the guest site this is all that runs, so the markup
  // and network behaviour are exactly as before this build.
  if (!isEditing) return <>{children}</>;

  const open = () => openEditor(fields, label);

  // Empty when every field this region edits has no stored value. Guarded on a
  // resolved property (null while the editor is still loading → treat as filled,
  // i.e. render children, never a spurious placeholder).
  const defs = fieldsForKeys(fields);
  const isEmpty =
    !noEmptyPlaceholder &&
    property != null &&
    defs.length > 0 &&
    defs.every((f) => isFieldEmpty(f, property, settings?.branding ?? {}));

  if (isEmpty) {
    return (
      <button
        type="button"
        onClick={(e) => {
          // Stop the click reaching an enclosing region (an empty inner region
          // inside a filled outer one must open ITS own editor).
          e.stopPropagation();
          open();
        }}
        aria-label={`Add ${label.toLowerCase()}`}
        className={`my-4 flex w-full items-center justify-center gap-2 rounded-lg border-2 border-dashed border-sand-border bg-sand/40 px-6 py-6 text-sm font-medium text-charcoal-muted transition-colors hover:border-accent hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream ${placeholderHeight(
          defs,
        )} ${className ?? ''}`}
      >
        <PlusIcon className="h-4 w-4" />
        Add {label.toLowerCase()}
      </button>
    );
  }

  return (
    <div
      className={`group/editable relative rounded-sm ring-2 ring-inset ring-transparent transition-[box-shadow] hover:ring-accent focus-within:ring-accent ${
        className ?? ''
      }`}
      onClick={(e) => {
        // Bubble-phase: the innermost Editable handles it first, then stops the
        // event so an enclosing region does not also open. preventDefault stops a
        // link/button in the preview from acting instead of opening the editor.
        e.preventDefault();
        e.stopPropagation();
        open();
      }}
    >
      {children}

      {/* The corner affordance is the keyboard entry point: a real <button>, so
          Enter/Space activate it natively. Hidden until the region is hovered or
          the button is focused, so the preview stays clean but stays reachable. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          open();
        }}
        aria-label={`Edit ${label}`}
        className="absolute right-1.5 top-1.5 z-10 inline-flex items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs font-semibold text-white opacity-0 shadow-sm transition-opacity group-hover/editable:opacity-100 focus:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
      >
        <EditIcon className="h-3.5 w-3.5" />
        Edit
      </button>
    </div>
  );
}
