/**
 * The comparison line — a second instrument's percent series, drawn over the price plot.
 *
 * Pure paint (see `src/renderer/CLAUDE.md`): percent values and a percent→Y scale in,
 * pixels out. The scale belongs to the caller, because the comparison shares its axis with
 * the primary's own percent series and only the caller can see both; a scale invented here
 * would fight the one the axis is labelled with.
 *
 * The layer's entry point owns the `clearRect` (mandate #2), exactly as it does for
 * `drawIndicatorOverlay` — this function is one of several draws onto the overlay layer and
 * must not wipe the ones before it.
 */

import { snapLine } from '../pixel.js';
import type { Rect } from '../layout.js';
import type { Theme } from '../theme.js';

export interface CompareDrawInput {
  /** Percent change per PRIMARY bar index. NaN where the secondary has no value. */
  readonly percent: Float64Array;
  readonly plot: Rect;
  readonly from: number;
  readonly to: number;
  /** Percent → Y. The caller owns the scale; this layer never invents one. */
  y(percent: number): number;
  x(index: number): number;
  /** §5 affine pair, for the dense path: x(i) = x0 + i * dx. */
  readonly x0: number;
  readonly dx: number;
  readonly color: string;
  readonly label: string;
  readonly theme: Theme;
}

/** Gap between the end of the line and its label, and between a label and the plot edge. */
const LABEL_GAP = 6;

export function drawCompareSeries(ctx: CanvasRenderingContext2D, input: CompareDrawInput): void {
  const { percent, plot } = input;
  const n = percent.length;
  if (n === 0) return;

  const from = Math.max(0, input.from);
  const to = Math.min(n - 1, input.to);
  // An empty overlap arrives as `from === -1`, which the clamps above turn into from 0,
  // to -1 — so `to < from` already covers it, and an explicit `input.from < 0` test could
  // not change any outcome. Nothing is drawn at all, not even a clip, so a comparison
  // with no overlapping history costs nothing and leaves no trace on the layer.
  if (to < from) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();

  ctx.strokeStyle = input.color;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([]);
  ctx.beginPath();

  // Above one bar per pixel column the polyline reduces to two points per column — the
  // minimum and the maximum in it, in that order (§5.1), the same reduction `strokePlot`
  // makes. One point per column is faster still and flattens every spike, which is the one
  // thing a sub-pixel line can honestly show. At 100k visible bars this is ~2400 `lineTo`
  // calls instead of 100k.
  const dense = to - from + 1 > plot.width;
  const x0 = input.x0;
  const dx = input.dx;

  let drawing = false;
  let column = Number.NaN;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  /** Largest index carrying a value: where the line actually ends, so where the label goes. */
  let endIndex = -1;

  const flush = (): void => {
    if (!Number.isFinite(lo)) return;
    const x = snapLine(column);
    // Low first, then high: the path walks the column's full extent rather than jumping
    // across it.
    const yLo = snapLine(input.y(lo));
    const yHi = snapLine(input.y(hi));
    if (drawing) ctx.lineTo(x, yLo);
    else ctx.moveTo(x, yLo);
    ctx.lineTo(x, yHi);
    drawing = true;
    lo = Number.POSITIVE_INFINITY;
    hi = Number.NEGATIVE_INFINITY;
  };

  for (let i = from; i <= to; i++) {
    const value = percent[i];
    if (Number.isNaN(value)) {
      // A gap BREAKS the path. Joining across it draws a straight line through the days the
      // secondary did not exist, which reads as real data.
      if (dense) flush();
      drawing = false;
      continue;
    }
    endIndex = i;

    if (!dense) {
      const x = snapLine(input.x(i));
      const y = snapLine(input.y(value));
      if (drawing) ctx.lineTo(x, y);
      else ctx.moveTo(x, y);
      drawing = true;
      continue;
    }

    const next = Math.round(x0 + i * dx);
    if (next !== column) {
      flush();
      column = next;
    }
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }
  if (dense) flush();

  ctx.stroke();

  if (endIndex >= 0 && input.label !== '') {
    drawLabel(ctx, input, endIndex, dense);
  }

  ctx.restore();
}

/**
 * The label sits at the LINE'S right-hand end, clamped into the plot — never at a fixed
 * plot edge.
 *
 * `drawDrawings` shipped that bug for level labels: every one was written at `plot.left + 6`
 * regardless of where its drawing was, so a fib on the right of the chart labelled itself on
 * the far left, over the legend, pointing at nothing. Here the same mistake would park
 * "SPY" against the right gutter while the comparison line stopped a third of the way across
 * (a delisted secondary, or one that simply has no bars yet for the newest primary bars).
 * The anchor is the last drawn point; the clamp only stops the label leaving the plot, which
 * this layer clips to, so an unclamped label is silently truncated rather than merely
 * misplaced.
 */
function drawLabel(
  ctx: CanvasRenderingContext2D,
  input: CompareDrawInput,
  endIndex: number,
  dense: boolean,
): void {
  const { plot } = input;
  const endX = snapLine(dense ? Math.round(input.x0 + endIndex * input.dx) : input.x(endIndex));
  const endY = snapLine(input.y(input.percent[endIndex]));

  ctx.font = input.theme.typography.font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = input.color;

  const width = ctx.measureText(input.label).width;
  const half = input.theme.typography.lineHeight / 2;
  const x = Math.min(
    Math.max(endX + LABEL_GAP, plot.left + LABEL_GAP),
    plot.left + plot.width - width - LABEL_GAP,
  );
  const y = Math.min(Math.max(endY, plot.top + half), plot.top + plot.height - half);
  ctx.fillText(input.label, x, y);
}
