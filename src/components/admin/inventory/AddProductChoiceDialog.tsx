import { useRef } from 'react';
import { Link } from 'react-router-dom';
import { CloseIcon, PlusIcon, UploadIcon } from '../../ui/icons';
import { useFocusTrap } from '../../../hooks/useFocusTrap';

// "ADD PRODUCT" ASKS ONE QUESTION FIRST: one, or many?
//
// WHY A CHOICE AND NOT A FORM WITH AN "IMPORT" LINK IN THE CORNER. The two jobs
// are the same job at different scales — a hotel adds three hundred items on its
// first afternoon and one item a week afterwards — and the bulk path used to be
// reachable only by noticing a small link on a different screen. People did not
// notice it, so they typed. Putting both in front of the one button people
// already press is the whole point.
//
// WHAT THIS IS NOT. It is deliberately NOT the opening-stock import, which
// people kept landing on by mistake: nothing on this dialog records a quantity.
// Both choices here create ITEM DEFINITIONS — what a thing is, its unit, its
// type. How much of it is on a shelf is a separate action, in a separate place,
// and the footnote says so rather than leaving the distinction to be discovered.
//
// A CENTRED MODAL, not the right-hand slide-over the forms use: a slide-over
// says "fill this in", and this asks a question with two answers. At 360px the
// two cards stack, and each is a full-width tap target.

interface AddProductChoiceDialogProps {
  propertySlug: string;
  onSingle: () => void;
  onClose: () => void;
}

export function AddProductChoiceDialog({
  propertySlug,
  onSingle,
  onClose,
}: AddProductChoiceDialogProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true, onClose);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-4">
      <div
        className="absolute inset-0 bg-charcoal/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="add-product-choice-title"
        className="relative flex max-h-full w-full max-w-lg flex-col overflow-y-auto rounded-t-2xl bg-cream shadow-2xl sm:rounded-2xl"
      >
        <header className="flex flex-none items-start justify-between gap-3 border-b border-sand-border px-4 py-4 sm:px-6">
          <div className="min-w-0">
            <h2
              id="add-product-choice-title"
              className="text-base font-semibold text-charcoal"
            >
              Add products
            </h2>
            <p className="mt-0.5 text-xs text-charcoal-muted">
              Define what a thing is — its unit, its type, its category. How much
              of it you hold comes afterwards.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-charcoal-muted transition-colors hover:bg-sand hover:text-charcoal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
          >
            <CloseIcon className="h-5 w-5" />
          </button>
        </header>

        <div className="space-y-3 px-4 py-4 sm:px-6">
          <button
            type="button"
            onClick={onSingle}
            className="flex w-full items-start gap-3 rounded-2xl border border-primary bg-primary/5 p-4 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-primary text-white"
            >
              <PlusIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-charcoal">
                Add a single product
              </span>
              <span className="mt-0.5 block text-sm text-charcoal-muted">
                Fill in one item — name, code, type, unit, category, reorder
                level. You can record what is already on its shelf in the same
                pass.
              </span>
            </span>
          </button>

          <Link
            to={`/admin/${propertySlug}/products/import`}
            onClick={onClose}
            className="flex w-full items-start gap-3 rounded-2xl border border-sand-border bg-white/60 p-4 text-left transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-sand text-charcoal"
            >
              <UploadIcon className="h-5 w-5" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-charcoal">
                Add many from a template
              </span>
              <span className="mt-0.5 block text-sm text-charcoal-muted">
                Download a sheet already showing the format with worked example
                rows, type your catalogue into it, and upload it back. Every row
                is checked — and names you already have are never created twice.
              </span>
            </span>
          </Link>
        </div>

        <footer className="flex-none border-t border-sand-border px-4 py-3 sm:px-6">
          <p className="text-xs text-charcoal-muted">
            Setting up from nothing?{' '}
            <Link
              to={`/admin/${propertySlug}/stock/import`}
              onClick={onClose}
              className="font-semibold text-primary underline underline-offset-2"
            >
              Load opening stock
            </Link>{' '}
            takes one sheet that does both — your items and what is on the shelf.
          </p>
        </footer>
      </div>
    </div>
  );
}
