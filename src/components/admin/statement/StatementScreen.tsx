import { Link } from 'react-router-dom';
import { ArrowLeftIcon } from '../../ui/icons';
import { describeError } from '../../../lib/errors';
import { useStatement, type StatementTarget } from '../../../hooks/useStatement';
import type { Property } from '../../../types/tenant';
import { StatementDocument } from './StatementDocument';

// THE STATEMENT PAGE'S CHROME — and nothing else.
//
// Everything in this file is print:hidden: the back link, the print button, the
// how-this-was-calculated note, and every failure state. What survives onto
// paper is StatementDocument alone, sitting inside an admin shell whose sidebar
// and header are already print:hidden (AdminLayout). No second renderer, so the
// page on screen and the page that prints cannot disagree.
//
// A ROUTE, NOT A MODAL, for the reasons the booking and guest pages give: it can
// be linked to, refreshed into, sent to a colleague — and, the one that matters
// here, printed on its own without the surrounding page coming with it.
//
// NO TOOLS. There is no void, no discount, no payment action and no kebab
// anywhere on this screen. The internal folio bill has all of them; this is the
// document the guest is handed, and a control on it is a control a guest can
// press.

interface StatementScreenProps {
  target: StatementTarget;
  property: Property;
  // Where "Back" goes: the stay it belongs to, or the guest's home. Computed by
  // the page, which knows which document was asked for.
  backHref: string;
  backLabel: string;
}

// Rule 16, for the staff member on screen (it is print:hidden — a tooltip on
// paper says nothing). It states what the document includes and, crucially,
// what it silently leaves out: the void trail a guest must not see.
const FIGURES_NOTE =
  'Every figure is computed live from this folio and nothing is stored: the ' +
  'subtotal is each charge after its discount, tax is the property’s active ' +
  'taxes and service charges applied per line, total charges is subtotal plus ' +
  'tax, payments is every payment net of refunds, and the balance is total ' +
  'charges less payments. VOIDED charges and payments are excluded from the ' +
  'totals AND hidden from this document — a guest should not be shown a ' +
  'reversed line. The void trail stays on the internal folio bill, with its ' +
  'reason and who voided it.';

export function StatementScreen({
  target,
  property,
  backHref,
  backLabel,
}: StatementScreenProps) {
  const { statement, missing, loading, error, reload } = useStatement(
    target,
    property,
  );

  return (
    <div className="mx-auto max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-3 print:hidden">
        <Link
          to={backHref}
          className="inline-flex items-center gap-2 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          <ArrowLeftIcon className="h-4 w-4" />
          {backLabel}
        </Link>

        <div className="flex items-center gap-2">
          {loading ? (
            <span className="text-xs text-charcoal-muted" aria-live="polite">
              Loading…
            </span>
          ) : null}
          {statement ? (
            <>
              <span
                className="cursor-help text-xs text-charcoal-muted"
                tabIndex={0}
                role="note"
                aria-label={FIGURES_NOTE}
                title={FIGURES_NOTE}
              >
                ⓘ How this is calculated
              </span>
              {/* The browser's own print dialog — no PDF library and no second
                  renderer. The document below IS what comes out. */}
              <button
                type="button"
                onClick={() => window.print()}
                className="rounded-full bg-accent px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
              >
                Print statement
              </button>
            </>
          ) : null}
        </div>
      </div>

      <div className="mt-4">
        {loading && !statement ? (
          <p
            className="py-10 text-center text-sm text-charcoal-muted print:hidden"
            aria-live="polite"
          >
            Loading statement…
          </p>
        ) : error ? (
          <div className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center print:hidden">
            <p className="text-sm font-medium text-charcoal">
              We couldn’t load this statement.
            </p>
            {/* Rule 11: the REAL diagnostic, never a friendly substitution. */}
            <p className="mt-1 text-sm text-charcoal-muted">{describeError(error)}</p>
            <button
              type="button"
              onClick={reload}
              className="mt-4 rounded-full border border-sand-border bg-white/70 px-4 py-2 text-sm font-semibold text-charcoal transition-colors hover:bg-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-cream"
            >
              Try again
            </button>
          </div>
        ) : missing ? (
          <MissingPanel missing={missing} kind={target.kind} />
        ) : statement ? (
          <StatementDocument statement={statement} />
        ) : null}
      </div>
    </div>
  );
}

// THE THREE WAYS THERE IS NO DOCUMENT — and they are not the same thing, so
// they do not share a message.
//
// A guest with no non-resident tab is an ordinary, benign state: nothing has
// ever been charged off-stay, so there is nothing to print. A BOOKING with no
// folio is a genuine fault — 021 §4.1 opens one for every booking via a trigger
// — and it must be said loudly rather than rendered as a convincing ₦0.00.
function MissingPanel({
  missing,
  kind,
}: {
  missing: 'subject' | 'folio' | 'totals';
  kind: StatementTarget['kind'];
}) {
  if (missing === 'subject') {
    return (
      <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal print:hidden">
        {kind === 'stay'
          ? 'This stay could not be found at this property. It may have been removed, or the link may belong to a different hotel.'
          : 'This guest could not be found in this tenant. They may have been removed, or the link may belong to a different hotel.'}
      </p>
    );
  }

  if (missing === 'folio' && kind === 'standalone') {
    return (
      <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal print:hidden">
        This guest has no non-resident account at this property, so there is
        nothing to print. One is opened the first time a charge or a payment is
        recorded against them outside a stay.
      </p>
    );
  }

  return (
    <p className="rounded-2xl border border-sand-border bg-white/60 p-6 text-center text-sm text-charcoal print:hidden">
      {missing === 'folio'
        ? 'This stay has no folio, which should not be possible — every booking is given one automatically. Please contact support rather than treating this as a zero balance.'
        : 'This folio’s totals could not be computed, so no statement can be issued. Nothing here should be treated as settled until it is investigated.'}
    </p>
  );
}
