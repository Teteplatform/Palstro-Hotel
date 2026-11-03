import { type ReactNode } from 'react';
import { useIsNarrow } from '../../hooks/useIsNarrow';

// ONE TABLE, TWO SHAPES (1.1a2) — because at 360px a table is not a table.
//
// ---------------------------------------------------------------------------
// WHAT WAS MEASURED, AND WHY IT IS NOT A WIDTH PROBLEM
// ---------------------------------------------------------------------------
// The receive form renders 992px of table inside a 295px window on a phone:
// 697px, two and a third screens, off to the right. At rest not one input is
// visible — the screen reads as a list of what was ordered followed by a Note
// box. The first column is not sticky, so scrolling right to reach the Arrived
// boxes takes the item names away with it, leaving unlabelled fields. Item sits
// at 40-289 and Reason at 922-992, so they can never be on screen together at
// any scroll position, and Reason is the column that is MANDATORY on a short
// delivery. The sequence on a phone is therefore: type a quantity, press Record
// delivery, read a refusal asking for a reason, and go looking 922px to the
// right for the field.
//
// That is not a column too wide. It is a layout that stops being a layout, and
// the fix is a different arrangement of the same facts.
//
// ---------------------------------------------------------------------------
// WHY ONE PRIMITIVE AND NOT SEVEN FIXES
// ---------------------------------------------------------------------------
// Seven tables in purchasing share this, which is the same shape as rule 23's
// finding that four menus had identical clipping markup: the reason they share a
// defect is that they were written seven times. Converting some now and the rest
// later means somebody re-deciding the column spec months from now with less
// context, and the one left out is always the one nobody tests. So the column
// list is declared ONCE per table and both shapes are rendered from it — a new
// column cannot appear in the table and be forgotten in the card, because there
// is only one place to add it.
//
// ---------------------------------------------------------------------------
// WHY THE BREAKPOINT IS JAVASCRIPT AND NOT CSS is argued where the decision
// lives, in hooks/useIsNarrow. The short of it: a card is a regrouping rather
// than a restack, two of these tables carry headers CSS cannot put in a
// data-label, and rendering both shapes and hiding one would put every input in
// the document twice.


// WHAT A COLUMN DOES IN EACH SHAPE. `field` is the default and is the ordinary
// case: a heading in the table, a label beside its value in the card.
export type DataColumnRole =
  // A tick box or similar: no header, and it sits beside the card's title.
  | 'select'
  // The row's subject. The card's title line, with no label — "Rice (long
  // grain)" needs no caption saying Item.
  | 'heading'
  // Something you type into. In the card it gets its label ABOVE and the full
  // width of the card, because a 90px input in a label/value pair on a phone is
  // the problem this file exists to fix.
  | 'control'
  | 'field';

export interface DataColumn<T> {
  key: string;
  header: ReactNode;
  // The second line of a two-line header — "at the agreed price". Carried here
  // rather than being baked into `header` so the card can use it as the label's
  // qualifier instead of a second line nobody reads.
  headerNote?: string;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  role?: DataColumnRole;
  // Extra classes for the table's `<td>`, where a table needs its own look.
  cellClassName?: string;
  headerClassName?: string;
}

// A cell that renders nothing is SKIPPED in the card rather than printing an
// empty label — several of these columns deliberately render null when they have
// nothing to say (a difference of zero, a cost that did not move). In the table
// an empty cell keeps the grid; in a card it would be a caption with nothing
// after it.
function isEmptyCell(node: ReactNode): boolean {
  return node === null || node === undefined || node === false || node === '';
}

export interface DataTableProps<T> {
  columns: DataColumn<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  // The table's own min-width class, kept exactly as it was: above the
  // breakpoint nothing about these tables changes.
  minWidthClass: string;
  // The table's text size, which differs between modules (text-sm in
  // purchasing, text-xs on the provenance report).
  textClass?: string;
  tableClassName?: string;
  // Classes for a whole row, by row — used for the zebra and border rules each
  // table already had.
  rowClassName?: (row: T, index: number) => string;
  // An accessible name for the card list, which is not a table and so has no
  // headers to be named by.
  cardListLabel: string;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  minWidthClass,
  textClass = 'text-sm',
  tableClassName = '',
  rowClassName,
  cardListLabel,
}: DataTableProps<T>) {
  const narrow = useIsNarrow();

  if (narrow) {
    return (
      <ul className="space-y-3" aria-label={cardListLabel}>
        {rows.map((row) => (
          <DataCard
            key={rowKey(row)}
            row={row}
            columns={columns}
            textClass={textClass}
          />
        ))}
      </ul>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={`w-full ${minWidthClass} ${textClass} ${tableClassName}`}>
        <thead>
          <tr className="border-b border-sand-border text-left text-xs font-medium text-charcoal-muted">
            {columns.map((column) => (
              <th
                key={column.key}
                className={`py-2 ${column.align === 'right' ? 'text-right' : ''} ${
                  column.headerClassName ?? 'pr-3'
                }`}
              >
                {column.header}
                {column.headerNote ? (
                  <span className="block text-[0.65rem] font-normal normal-case">
                    {column.headerNote}
                  </span>
                ) : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr
              key={rowKey(row)}
              className={rowClassName?.(row, index) ?? 'border-b border-sand-border/60 last:border-0'}
            >
              {columns.map((column) => (
                <td
                  key={column.key}
                  className={`py-2 ${column.align === 'right' ? 'text-right' : ''} ${
                    column.cellClassName ?? 'pr-3'
                  }`}
                >
                  {column.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// THE CARD. Every cell of a row is inside it, which is the whole point: the item
// name, the box you type the quantity into and the box you type the reason into
// are one container at any width, and no scroll position can separate them.
//
// Columns keep their DECLARED ORDER rather than being grouped by role, so
// somebody who uses both shapes reads the same sequence in both.
function DataCard<T>({
  row,
  columns,
  textClass,
}: {
  row: T;
  columns: DataColumn<T>[];
  textClass: string;
}) {
  const select = columns.filter((c) => c.role === 'select');
  const heading = columns.find((c) => c.role === 'heading');
  const rest = columns.filter((c) => c.role !== 'select' && c.role !== 'heading');

  return (
    <li
      className={`rounded-xl border border-sand-border bg-white/60 p-3 ${textClass}`}
    >
      {select.length > 0 || heading ? (
        <div className="flex items-start gap-3">
          {select.map((column) => (
            <div key={column.key} className="pt-0.5">
              {column.cell(row)}
            </div>
          ))}
          {heading ? (
            <div className="min-w-0 flex-1">{heading.cell(row)}</div>
          ) : null}
        </div>
      ) : null}

      <dl className={select.length > 0 || heading ? 'mt-2 space-y-2' : 'space-y-2'}>
        {rest.map((column) => {
          const content = column.cell(row);
          if (isEmptyCell(content)) return null;

          const label = (
            <>
              {column.header}
              {column.headerNote ? (
                <span className="font-normal"> · {column.headerNote}</span>
              ) : null}
            </>
          );

          // A CONTROL GETS THE WHOLE WIDTH. An input squeezed into the value
          // half of a label/value pair on a 360px screen is a 120px box, which
          // is how a quantity gets mistyped.
          if (column.role === 'control') {
            return (
              <div key={column.key}>
                <dt className="text-xs font-medium text-charcoal-muted">
                  {label}
                </dt>
                <dd className="mt-1">{content}</dd>
              </div>
            );
          }

          return (
            <div key={column.key} className="flex items-baseline justify-between gap-3">
              <dt className="text-xs font-medium text-charcoal-muted">{label}</dt>
              <dd className="min-w-0 text-right">{content}</dd>
            </div>
          );
        })}
      </dl>
    </li>
  );
}
