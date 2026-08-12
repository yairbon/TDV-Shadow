/**
 * Level of detail (Phase 10.1).
 *
 * Below one CSS pixel per bar there are more bars than columns to draw them in, so the
 * renderer aggregates: one column per pixel, carrying the OHLC of every bar that falls in
 * it. Drawing 100k individual 1px rects into 1200 columns is not just slow, it is wrong —
 * later bars paint over earlier ones and the column shows the LAST bar in it rather than
 * the range of all of them, which hides every spike.
 *
 * The aggregation is the standard one: open of the first bar, close of the last, max high,
 * min low, summed volume. That is exactly a resampled bar, so a column is a real OHLC bar
 * for a wider period and reads correctly at any zoom.
 *
 * Buckets are formed by PIXEL COLUMN, not by a fixed bar count, because the column is what
 * the user sees. A fixed stride would make bucket boundaries drift against the pixel grid
 * as the chart pans, and the series would shimmer.
 */

import type { Bar, Price } from '../../data/types.js';

/** One aggregated column. `index` is the first bar in it, for hit-testing and labels. */
export interface LodColumn {
  readonly index: number;
  /** Already-rounded CSS pixel column. */
  readonly x: number;
  // Branded exactly like a Bar's: every value here IS one of the input bars' prices
  // (first open, last close, max high, min low), never an average, so no conversion is
  // involved and none is invented.
  readonly o: Price;
  readonly h: Price;
  readonly l: Price;
  readonly c: Price;
  readonly v: number;
}

/** Below this many CSS px per bar, aggregate. At or above it, draw every bar. */
export const LOD_THRESHOLD = 1;

export function shouldAggregate(barSpacing: number, visibleCount: number): boolean {
  return barSpacing < LOD_THRESHOLD && visibleCount > 1;
}

/**
 * Aggregates `bars[from..to]` into one entry per pixel column.
 *
 * The mapping is passed as the AFFINE PAIR `(x0, dx)` from §5 rather than as a callback:
 * `x(i) = x0 + i * dx`. Two reasons, and the second is the one that matters — it states
 * structurally that the mapping is monotone, which is what lets this run in a single pass;
 * and it keeps a per-bar indirect call out of a loop that runs 100k times a frame at full
 * zoom-out, where that call was most of the cost.
 */
export function aggregateByColumn(
  bars: readonly Bar[],
  from: number,
  to: number,
  x0: number,
  dx: number,
): LodColumn[] {
  const out: LodColumn[] = [];
  if (to < from || bars.length === 0) return out;

  const start = Math.max(0, from);
  const end = Math.min(bars.length - 1, to);
  if (end < start) return out;

  let column = Math.round(x0 + start * dx);
  let first = bars[start];
  let index = start;
  let high = first.h;
  let low = first.l;
  let close = first.c;
  let volume = first.v;

  for (let i = start + 1; i <= end; i++) {
    const bar = bars[i];
    const next = Math.round(x0 + i * dx);
    if (next !== column) {
      out.push({ index, x: column, o: first.o, h: high, l: low, c: close, v: volume });
      column = next;
      first = bar;
      index = i;
      high = bar.h;
      low = bar.l;
      close = bar.c;
      volume = bar.v;
      continue;
    }
    if (bar.h > high) high = bar.h;
    if (bar.l < low) low = bar.l;
    close = bar.c;
    volume += bar.v;
  }
  out.push({ index, x: column, o: first.o, h: high, l: low, c: close, v: volume });
  return out;
}
