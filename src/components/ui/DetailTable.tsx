import type { ReactNode } from 'react';

// The two-column label/value TABLE (build A §2, §3).
//
// Built once, here, for the same reason the Pagination control was built before
// the first list screen: three screens each rolling their own definition list is
// three different paddings, three different label widths and three places to fix
// the next alignment bug. Guest Details and Stay both render through this, and
// every later detail surface should too.
//
// A real <table> with <th scope="row">, not a styled <dl>: this IS tabular data —
// a field name and its value — and a screen reader announces the row header with
// the value, which a stack of divs does not. The label column is fixed-width so
// values line up down the page instead of ragging with the label text.
//
// At 360px the table stays readable rather than scrolling: the label column
// narrows and values wrap, because a two-column label/value table has nothing to
// scroll to — unlike the folio ledger, where the figure columns must stay whole.

export function DetailTable({
  caption,
  children,
}: {
  // The visible heading for the section. Rendered as a <caption> so the table is
  // self-describing, which is exactly the "tell at a glance what you are looking
  // at" principle in §3.
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full border-collapse text-sm">
        {caption ? (
          <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            {caption}
          </caption>
        ) : null}
        <tbody className="divide-y divide-sand-border/70">{children}</tbody>
      </table>
    </div>
  );
}

export function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <tr>
      <th
        scope="row"
        className="w-[9.5rem] px-4 py-2.5 text-left align-top text-xs font-medium text-charcoal-muted sm:w-[12rem] sm:text-sm"
      >
        {label}
      </th>
      <td className="px-4 py-2.5 align-top text-sm text-charcoal">{children}</td>
    </tr>
  );
}
