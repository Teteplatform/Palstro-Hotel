import { useRef } from 'react';
import { CloseIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';
import { ItemImageField } from './ItemImageField';

// THE PICTURE, FROM THE TILE (1.1f §5) — a small dialog that hosts the existing
// picture field, opened by clicking an item's thumbnail on the list.
//
// ---------------------------------------------------------------------------
// WHY A DIALOG AND NOT A ROUTE THROUGH "EDIT ITEM"
// ---------------------------------------------------------------------------
// Adding a picture to forty items is forty rounds of: open the row, press Edit
// item, wait for a slide-over carrying a whole form, scroll past name, code, type,
// unit, category, barcode, pack size, two costs and three thresholds, upload,
// close. The picture is the only field with an obvious affordance already on
// screen — an empty tile that plainly wants one — and routing it through a form
// about everything else is the kind of friction that ends with a catalogue of grey
// squares.
//
// So the tile IS the control: empty invites a picture, filled replaces it.
//
// ---------------------------------------------------------------------------
// IT ADDS NO UPLOAD MACHINERY, AND THAT IS THE POINT
// ---------------------------------------------------------------------------
// ItemImageField already owns the whole job — the resize, the quota readout, the
// commit-then-release ordering that keeps a replaced picture from stranding bytes
// nothing references. This is a frame around it. A second upload path would mean a
// second place for the file-and-row lockstep to be got wrong, which §6 of CLAUDE.md
// is explicit about.

interface ItemImageDialogProps {
  tenantId: string;
  itemId: string;
  itemName: string;
  imageAssetId: string | null;
  // Re-pull the list so the row's thumbnail is the server's version. Awaited by
  // the field, so the dialog cannot close over a half-finished write.
  onChanged: () => Promise<void> | void;
  onClose: () => void;
}

export function ItemImageDialog({
  tenantId,
  itemId,
  itemName,
  imageAssetId,
  onChanged,
  onClose,
}: ItemImageDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-charcoal/40" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Picture for ${itemName}`}
        className="relative flex max-h-full w-full max-w-lg flex-col overflow-hidden rounded-2xl bg-cream shadow-2xl"
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-sand-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-charcoal">
              {imageAssetId ? 'Replace the picture' : 'Add a picture'}
            </h2>
            {/* ONE LINE (rule 25). What a picture costs against the storage
                allowance, and that removing one frees it again, is on the
                uploader itself and in the guide. */}
            <p className="mt-0.5 truncate text-xs text-charcoal-muted">{itemName}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream focus-visible:outline-none"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-4 py-4">
          <ItemImageField
            tenantId={tenantId}
            itemId={itemId}
            itemName={itemName}
            imageAssetId={imageAssetId}
            onChanged={onChanged}
          />
        </div>
      </div>
    </div>
  );
}
