import { Link } from 'react-router-dom';
import { useActiveProperty } from '../../hooks/useActiveProperty';

// Route: /admin/:propertySlug/requisitions — the Requisitions module, promoted
// out of the Inventory tab row into a sidebar entry of its own.
//
// WHY IT IS A MODULE AND NOT A TAB. A requisition is not a view of the stock
// list; it is a conversation between two locations with an approval in the
// middle, and it has state the stock list has no place to hold: a queue of
// requests, a count of the ones waiting on YOU, and two different screens
// depending on whether you are the one asking or the one sending. Building that
// as a tab would mean rebuilding it as a page the day it became real.
//
// WHY THIS PAGE EXISTS BEFORE THE ENGINE. The alternative was leaving the nav
// entry disabled, which is what it was. A disabled span cannot explain the flow,
// cannot say what it waits on, and cannot tell the storekeeper what to do in the
// meantime — and "what do I do today?" is the only question somebody clicking
// Requisitions actually has. So the route exists and answers all three, and the
// page will fill in behind the same URL when the engine lands.
//
// NOTHING HERE IS INVENTED. No counts, no sample requests, no empty table
// pretending to be a queue. Every number on this page would have to come from a
// table that does not exist yet, so there are none.

export function RequisitionsPage() {
  const { property } = useActiveProperty();
  if (!property) return null;

  const slug = property.slug;

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-5">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight text-charcoal">
            Requisitions
          </h1>
          <span className="rounded-full bg-sand px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-charcoal-muted">
            Not built yet
          </span>
        </div>
        <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
          How the kitchen, the bar and housekeeping get what they need out of the
          store — asked for, sent, and confirmed by both sides.
        </p>
      </header>

      <section className="rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-charcoal">
          The flow it will provide
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
          Three steps, and the third is the one that matters: stock is not
          counted as moved until the side receiving it says what actually
          arrived.
        </p>

        <ol className="mt-4 space-y-4">
          <Step
            n={1}
            title="Raise"
            body="The kitchen, bar or housekeeping asks the store for what it needs — items and quantities, in each item’s own base unit, against their own location."
          />
          <Step
            n={2}
            title="The store sends"
            body="The storekeeper issues what they are actually sending, which is not always what was asked for. Short-supplying five of the ten kilograms requested is normal, and the request records both figures rather than quietly closing at ten."
          />
          <Step
            n={3}
            title="The requester confirms"
            body="Whoever asked confirms what turned up. Only then is the movement complete: stock leaves the store and arrives in the kitchen as one linked pair, and a difference between sent and received is visible instead of vanishing."
          />
        </ol>

        <div className="mt-5 rounded-xl border border-sand-border bg-sand/30 p-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            Why both sides have to confirm
          </h3>
          <p className="mt-1 max-w-2xl text-sm text-charcoal">
            One-sided issuing is how stock goes missing without anybody lying.
            The store records ten kilograms out, the kitchen receives eight, and
            with a single confirmation the two are never compared — the shortfall
            becomes the kitchen’s problem, months later, as an unexplained
            variance. Two-sided confirmation puts the gap on the record on the
            day it happens, with both names against it.
          </p>
        </div>
      </section>

      <section className="mt-4 rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-charcoal">
          Stock transfers live here too
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-charcoal-muted">
          Moving stock from one location to another used to be listed as its own
          tab under Inventory. It is not a separate feature: a transfer is the
          same two-sided movement as a requisition without the asking step —
          stock leaving one place and the same stock arriving in another, as one
          linked pair rather than two unrelated entries. It arrives with this
          module.
        </p>
      </section>

      <section className="mt-4 rounded-2xl border border-dashed border-sand-border bg-white/40 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-charcoal">
          What has to exist first
        </h2>
        <ul className="mt-3 space-y-2">
          <Need
            title="Staff and roles"
            body="A requisition needs to know who may request, who may approve and send, and for which location. Today everyone who can open Inventory can see and touch every location — there is no way to say “this person runs the Kitchen”. That layer is not built, and without it an approval would be a formality anyone could perform."
          />
          <Need
            title="The issue and transfer movement types"
            body="The movement ledger already reserves them (issued out, issued in, transferred out, transferred in) and nothing can write them yet. They post in linked pairs, so the pairing is part of the engine rather than something a screen arranges."
          />
        </ul>
      </section>

      <section className="mt-4 rounded-2xl border border-sand-border bg-white/60 p-4 sm:p-6">
        <h2 className="text-base font-semibold text-charcoal">
          What to do until then
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-charcoal">
          Move stock between locations as{' '}
          <strong className="font-semibold">two adjustments</strong>: remove it
          from the location it left, add it to the location it went to, with the
          same reason written on both so the pair can be read as one move later.
          Both are permanent and both carry your name, which is the part that
          matters.
        </p>
        <p className="mt-2 max-w-2xl text-sm text-charcoal-muted">
          It is worth knowing what this does not give you: the two entries are
          not linked, so nothing checks that what left equals what arrived, and
          nothing records that anybody asked. That check is exactly what this
          module adds.
        </p>
        <Link
          to={`/admin/${slug}/inventory`}
          className="mt-4 inline-flex items-center gap-2 rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-cream"
        >
          Go to Inventory → Adjustments
        </Link>
      </section>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-3">
      <span
        aria-hidden="true"
        className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/10 text-sm font-bold text-primary"
      >
        {n}
      </span>
      <div className="min-w-0">
        <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
        <p className="mt-0.5 max-w-2xl text-sm text-charcoal-muted">{body}</p>
      </div>
    </li>
  );
}

function Need({ title, body }: { title: string; body: string }) {
  return (
    <li>
      <h3 className="text-sm font-semibold text-charcoal">{title}</h3>
      <p className="mt-0.5 max-w-2xl text-sm text-charcoal-muted">{body}</p>
    </li>
  );
}
