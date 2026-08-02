import type { ReactNode } from 'react';

// THE COMPACT FACT TABLE — a dense label/value table in the same sharp style as
// the folio bill and the stays table.
//
// WHY NOT ONE FACT PER ROW, which is what this replaced. A wide label column and
// a single pair per row is right for a form-like surface you read top to bottom,
// and wrong for a reservation: seven short facts become seven tall rows and half
// a screen of whitespace on desktop, so the thing a receptionist actually wants
// — the nights, the dates, who is paying — is spread over a scroll instead of
// taking one glance.
//
// So this lays the SAME facts out TWO PAIRS PER ROW from `sm` up, and one pair
// per row below it. Seven facts become four rows on a laptop and stay a clean
// single column at 360px, with no horizontal scroll at any width — a label/value
// table has nothing to scroll TO, unlike the folio's figure columns.
//
// TWO tbodies, one per breakpoint, rather than one clever responsive row. It is
// the idiom already used by the stays table's mobile fold, and it is the honest
// trade: a little duplicated markup for short text, in exchange for two layouts
// that are each simply correct rather than one that is nearly correct at both.
// The hidden one is aria-hidden so a screen reader reads each fact exactly once.
//
// Still a real <table> with <th scope="row">, not a styled <dl>: this IS tabular
// data — a field name and its value — and a screen reader announces the row
// header with the value, which a stack of divs does not.

export interface Fact {
  label: string;
  // Rendered as-is. A caller with nothing to show passes the shared
  // MISSING_VALUE dash (never an empty string — §6), or omits the fact entirely
  // when an absent row reads better than a dashed one.
  value: ReactNode;
}

export function FactTable({
  caption,
  facts,
}: {
  // The visible heading, rendered as a <caption> so the table is
  // self-describing.
  caption?: string;
  facts: Fact[];
}) {
  // Pairs for the desktop layout: [0,1], [2,3], … A trailing odd fact gets an
  // empty second pair, which renders as blank cells rather than a stretched row.
  const pairs: [Fact, Fact | null][] = [];
  for (let i = 0; i < facts.length; i += 2) {
    pairs.push([facts[i], facts[i + 1] ?? null]);
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-sand-border bg-white/60">
      <table className="w-full border-collapse text-sm">
        {caption ? (
          <caption className="border-b border-sand-border bg-sand/40 px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-charcoal-muted">
            {caption}
          </caption>
        ) : null}

        {/* MOBILE: one fact per row. */}
        <tbody className="divide-y divide-sand-border/70 sm:hidden">
          {facts.map((fact) => (
            <tr key={fact.label}>
              <Label>{fact.label}</Label>
              <Value>{fact.value}</Value>
            </tr>
          ))}
        </tbody>

        {/* DESKTOP: two facts per row. */}
        <tbody
          aria-hidden="true"
          className="hidden divide-y divide-sand-border/70 sm:table-row-group"
        >
          {pairs.map(([left, right]) => (
            <tr key={left.label}>
              <Label>{left.label}</Label>
              <Value>{left.value}</Value>
              {right ? (
                <>
                  <Label>{right.label}</Label>
                  <Value>{right.value}</Value>
                </>
              ) : (
                <>
                  <td className="px-3 py-2" />
                  <td className="px-3 py-2" />
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Compact padding, and a label column narrow enough for two pairs to fit a
// laptop without the values ragging.
function Label({ children }: { children: ReactNode }) {
  return (
    <th
      scope="row"
      className="w-[8.5rem] whitespace-nowrap px-3 py-2 text-left align-top text-xs font-medium text-charcoal-muted sm:w-[7.5rem] sm:px-4"
    >
      {children}
    </th>
  );
}

function Value({ children }: { children: ReactNode }) {
  return (
    <td className="px-3 py-2 align-top text-sm text-charcoal sm:px-4">
      {children}
    </td>
  );
}
