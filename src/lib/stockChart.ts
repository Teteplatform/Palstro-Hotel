import type { ItemMovement } from './itemDetail';

// THE STOCK CHART'S ARITHMETIC (1.1f §3) — a pure module, no React in it.
//
// ---------------------------------------------------------------------------
// WHY THIS IS ITS OWN FILE
// ---------------------------------------------------------------------------
// Two reasons, and the second one is the one that mattered.
//
// FIRST, it is the part worth being careful about. There is no charting library
// in this bundle and this shipment does not add one — the chart itself is a
// polyline and a list of circles, and the smallest serious library is a couple of
// hundred kilobytes shipped to a storekeeper on a Nigerian mobile connection to
// draw one line. What a library WOULD have brought is this: the scaling, the
// degenerate cases, the placement of zero. Extracted as a pure function of
// numbers, exactly as placePopover is, it can be proven exhaustively without a
// browser, a layout engine or a fake DOM that returns zeros for everything.
//
// SECOND, the linter asked for it and was right. Exporting these alongside the
// component trips react-refresh/only-export-components — "use a new file to share
// constants or functions between components" — and the honest response was to do
// that rather than add three more errors to a baseline. The proof now imports the
// arithmetic without importing React at all, which is what a pure module should
// allow.

// ---------------------------------------------------------------------------
// THE ARITHMETIC, AS A PURE FUNCTION
// ---------------------------------------------------------------------------

export interface SeriesPoint {
  // Position along the x axis, 0..1, by INDEX rather than by date — see plotSeries.
  x: number;
  // The stock level after this movement.
  value: number;
}

export interface PlottedPoint {
  cx: number;
  cy: number;
  value: number;
}

export interface Plot {
  points: PlottedPoint[];
  // The polyline through them, as an SVG points attribute.
  path: string;
  // Where zero sits vertically, so the baseline can be drawn — and so a negative
  // stock level is visibly BELOW something rather than merely low.
  zeroY: number;
  // The value axis actually used, after padding. Exposed so the caller can label
  // it and a proof can assert the padding rather than infer it.
  min: number;
  max: number;
}

// Chart box in SVG user units. The SVG scales to its container via viewBox, so
// these are not pixels and do not need to match any screen.
export const CHART = { width: 720, height: 200, padX: 8, padY: 14 } as const;

// Map a series to coordinates.
//
// X IS BY INDEX, NOT BY DATE, and that is a deliberate choice rather than a
// shortcut. A hotel's movements are not evenly spaced: an item might have three
// in one morning and then nothing for six weeks, and a time-proportional axis
// renders that as three points overlapping into a single dot plus a long empty
// stretch — the six weeks of nothing being the part that draws the eye, when the
// three movements are the part with information in them. Even spacing makes every
// movement equally clickable, which is what this chart is for. The DATE is on
// every point's tooltip, so the timeline is not lost, it is just not the axis.
//
// THE DEGENERATE CASES, each of which would otherwise produce NaN or a divide by
// zero, and each of which is real:
//   * NO points      — an item that has never moved here. Returns an empty plot;
//                      the caller renders an empty state rather than an axis.
//   * ONE point      — an item with only an opening balance. Placed at the
//                      horizontal centre, because a single point at x=0 reads as
//                      a line that was cut off.
//   * AN ALL-ZERO series — every level is 0, so max === min === 0 and the span is
//                      zero. Padded to a unit range and drawn through the middle,
//                      rather than dividing by nothing.
//
// THAT LAST CASE IS NARROWER THAN IT LOOKS, and the comment here used to get it
// wrong. It said "a flat line — every movement nets to the same level" — but zero
// is FORCED into the range on the two lines below, so a flat line at 7 kg has
// min 0 and max 7 and a perfectly good span. The only series that collapses is one
// that is flat AT ZERO: an item received and then entirely written off, which is
// real and does happen.
//
// The error was found by removing the guard and watching which assertion went red.
// Exactly one did — the all-zero case — while "a flat line does not divide by zero"
// stayed green, because it never could have. A proof made to fail does not only
// check the code; it checks what you believed about the code.
export function plotSeries(points: SeriesPoint[], box = CHART): Plot {
  const innerW = box.width - box.padX * 2;
  const innerH = box.height - box.padY * 2;

  if (points.length === 0) {
    return { points: [], path: '', zeroY: box.padY + innerH / 2, min: 0, max: 0 };
  }

  const values = points.map((p) => p.value);
  let min = Math.min(...values, 0); // ZERO IS ALWAYS IN RANGE, so the baseline is real
  let max = Math.max(...values, 0);

  if (max === min) {
    // Reachable only when every value is zero (see the header): zero is forced
    // into the range above, so any non-zero level gives a real span. Give it a
    // unit range so the line lands in the middle instead of dividing by nothing.
    min -= 1;
    max += 1;
  }

  const span = max - min;
  const toY = (value: number) =>
    box.padY + innerH - ((value - min) / span) * innerH;

  const toX = (index: number) =>
    points.length === 1
      ? box.padX + innerW / 2
      : box.padX + (index / (points.length - 1)) * innerW;

  const plotted = points.map((p, i) => ({
    cx: toX(i),
    cy: toY(p.value),
    value: p.value,
  }));

  return {
    points: plotted,
    path: plotted.map((p) => `${p.cx},${p.cy}`).join(' '),
    zeroY: toY(0),
    min,
    max,
  };
}

// The series a set of movements draws: the scoped running level after each one.
// Separate from plotSeries so the mapping from DOMAIN to numbers and the mapping
// from numbers to COORDINATES are two things that can be checked apart.
export function seriesFrom(movements: ItemMovement[]): SeriesPoint[] {
  return movements.map((m, i) => ({ x: i, value: m.scoped_quantity }));
}

