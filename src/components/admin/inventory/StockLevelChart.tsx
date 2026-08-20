import { useId, useRef, useState } from 'react';
import { Popover } from '../../ui/Popover';
import { formatDisplayDate } from '../../../lib/date';
import { formatQuantity, formatSignedQuantity } from '../../../lib/format';
import { movementTypeLabel } from '../../../lib/stockLabels';
import type { ItemMovement } from '../../../lib/itemDetail';
import { CHART, plotSeries, seriesFrom } from '../../../lib/stockChart';

// STOCK LEVEL OVER TIME — one line, one point per movement, coloured by type.
//
// ---------------------------------------------------------------------------
// WHY THERE IS NO CHARTING LIBRARY IN THIS FILE
// ---------------------------------------------------------------------------
// Because the whole chart is a polyline and a list of circles, and the smallest
// serious charting library is a couple of hundred kilobytes shipped to a
// storekeeper on a Nigerian mobile connection to draw one line. The bundle has no
// charting dependency and this shipment does not add one.
//
// What a library WOULD have brought is the part worth being careful about — the
// scaling arithmetic — and that lives in lib/stockChart as a pure module, for
// exactly the reason placePopover is extracted: it is the part most likely to be
// wrong at a degenerate input (one point, a flat line, a negative floor), and a
// pure function of numbers can be proven exhaustively without a browser, a layout
// engine or a fake DOM that returns zeros for everything. This file is what is
// left once that is gone: markup, and the mapping from a movement type to a token.
//
// ---------------------------------------------------------------------------
// WHAT THIS CHART IS NOT
// ---------------------------------------------------------------------------
// It is not the variance report (6.6), and it is not a multi-series comparison.
// One line: the selected location's stock, or the property total when the scope
// is every location. Two locations drawn together would invite reading one
// against the other, which is a question about variance and needs the machinery
// that shipment brings.
//
// COLOURS ARE THE EXISTING TOKENS, via the same movementTypeTone map the ledger
// badges use. A chart with its own palette would mean an adjustment was one
// colour in the table and another in the picture directly above it.

// ---------------------------------------------------------------------------
// The colours — the ledger's tones, resolved to a stroke
// ---------------------------------------------------------------------------
// movementTypeTone returns Tailwind CLASSES for a badge, which an SVG fill cannot
// use directly. This maps the same three groupings to the same three tokens, so a
// point and its badge agree. Tokens only, never a literal (rule 17 / §8).
function pointClass(type: ItemMovement['movement_type']): string {
  switch (type) {
    case 'opening':
      return 'fill-primary';
    case 'adjustment':
    case 'count_adjustment':
    case 'wastage':
      return 'fill-accent';
    case 'reversal':
      return 'fill-primary/60';
    default:
      return 'fill-charcoal-muted';
  }
}

interface StockLevelChartProps {
  movements: ItemMovement[];
  baseUnit: string;
  // The scope, in words, for the caption — "Main Store" or "every location".
  scopeName: string;
  // Scroll the ledger to a movement and highlight it. The chart is a way INTO the
  // ledger rather than a picture beside it.
  onSelectMovement: (movementId: string) => void;
}

export function StockLevelChart({
  movements,
  baseUnit,
  scopeName,
  onSelectMovement,
}: StockLevelChartProps) {
  const titleId = useId();
  // Which point's tooltip is open, and the element it is anchored to. The anchor
  // is STATE and not a ref, for the reason ActionMenu records: React does not
  // re-render when a ref's .current changes, so a popover handed one during
  // render would position against the previous pass's element.
  const [hovered, setHovered] = useState<{
    index: number;
    anchor: SVGCircleElement;
  } | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const series = seriesFrom(movements);
  const plot = plotSeries(series);

  if (movements.length === 0) {
    return (
      <div className="rounded-2xl border border-dashed border-sand-border bg-white/40 px-6 py-10 text-center">
        <p className="text-sm text-charcoal-muted">
          Nothing has moved here yet, so there is no line to draw.
        </p>
      </div>
    );
  }

  const first = movements[0];
  const last = movements[movements.length - 1];
  const hoveredMovement = hovered ? movements[hovered.index] : null;

  return (
    <section
      className="rounded-2xl border border-sand-border bg-white/60 p-4"
      aria-labelledby={titleId}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={titleId} className="text-sm font-semibold text-charcoal">
          Stock level over time
        </h3>
        <p className="text-xs text-charcoal-muted">
          {scopeName} · {formatDisplayDate(first.business_date)} to{' '}
          {formatDisplayDate(last.business_date)}
        </p>
      </div>

      {/* THE TABLE IS THE ACCESSIBLE VERSION OF THIS PICTURE, and it is directly
          below on the same page — so the SVG is marked as an image with a
          description rather than pretending to be a data structure a screen
          reader can walk. A chart that announces four hundred coordinates is
          worse than one that says what it shows and points at the ledger. */}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART.width} ${CHART.height}`}
        className="mt-3 h-44 w-full overflow-visible"
        role="img"
        aria-label={`Stock level at ${scopeName} after each of ${movements.length} movements, ending at ${formatQuantity(last.scoped_quantity)} ${baseUnit}. The same movements are listed in the table below.`}
      >
        {/* ZERO, always drawn, because a negative stock level has to be visibly
            below something. Rule 7's display half: a negative is never floored,
            so the axis has to admit it exists. */}
        <line
          x1={CHART.padX}
          x2={CHART.width - CHART.padX}
          y1={plot.zeroY}
          y2={plot.zeroY}
          className="stroke-sand-border"
          strokeWidth={1}
          strokeDasharray="4 4"
        />

        <polyline
          points={plot.path}
          fill="none"
          className="stroke-primary"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />

        {plot.points.map((p, i) => {
          const movement = movements[i];
          return (
            <circle
              key={movement.id}
              // Same reason as the ledger row's: the proof pairs points to rows by
              // identity, which is what "row for row" has to mean.
              data-movement-id={movement.id}
              cx={p.cx}
              cy={p.cy}
              r={hovered?.index === i ? 7 : 4.5}
              className={`${pointClass(movement.movement_type)} cursor-pointer transition-all`}
              stroke="white"
              strokeWidth={1.5}
              tabIndex={0}
              role="button"
              aria-label={`${movementTypeLabel(movement.movement_type)} on ${formatDisplayDate(movement.business_date)}, ${formatSignedQuantity(movement.quantity)} ${baseUnit}. Show it in the table.`}
              onMouseEnter={(e) => setHovered({ index: i, anchor: e.currentTarget })}
              onMouseLeave={() => setHovered(null)}
              onFocus={(e) => setHovered({ index: i, anchor: e.currentTarget })}
              onBlur={() => setHovered(null)}
              onClick={() => onSelectMovement(movement.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelectMovement(movement.id);
                }
              }}
            />
          );
        })}
      </svg>

      <div className="mt-1 flex justify-between text-[11px] text-charcoal-muted">
        <span>{formatQuantity(plot.min)}</span>
        <span>
          Each point is one movement · click it to find the row below
        </span>
        <span>{formatQuantity(plot.max)}</span>
      </div>

      {/* THE TOOLTIP GOES THROUGH THE SHARED POPOVER (rule 23) rather than being
          an absolutely-positioned div: this card sits inside a page that scrolls,
          and an absolute tooltip would be clipped by the first ancestor with
          overflow and would widen the card's scrollWidth on the way. */}
      <Popover
        open={hovered !== null}
        onClose={() => setHovered(null)}
        anchor={(hovered?.anchor as unknown as HTMLElement) ?? null}
        align="left"
        role="tooltip"
        ariaLabel="Movement"
        className="px-3 py-2"
      >
        {hoveredMovement ? (
          <div className="text-xs">
            <p className="font-semibold text-charcoal">
              {movementTypeLabel(hoveredMovement.movement_type)}
            </p>
            <p className="text-charcoal-muted">
              {formatDisplayDate(hoveredMovement.business_date)}
            </p>
            <p className="mt-1 text-charcoal">
              {formatSignedQuantity(hoveredMovement.quantity)} {baseUnit} · left{' '}
              <span className="font-semibold">
                {formatQuantity(hoveredMovement.scoped_quantity)} {baseUnit}
              </span>
            </p>
          </div>
        ) : null}
      </Popover>
    </section>
  );
}
