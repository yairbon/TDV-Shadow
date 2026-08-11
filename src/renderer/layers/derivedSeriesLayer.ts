/**
 * Draws a `DerivedSeries` in any of the nine draw styles.
 *
 * This replaces the built-in candle series layer whenever the chart type is not plain
 * candles. It obeys the same rules: clear first, clip to the plot, snap fills to whole
 * pixels and strokes to half-pixels, batch by colour, and allocate nothing per bar.
 *
 * Resampling types (Renko, Kagi, P&F, Line Break, Range) index their OWN bar array, so
 * `x(i)` here is the position of derived bar `i` — not of source bar `i`. Passing the
 * source index in would scatter bricks across the wrong columns.
 */

import type { DerivedSeries } from '../../charts/types.js';
import { snapFill, snapLine } from '../pixel.js';
import { candleGeometry } from '../scale/timeScale.js';
import type { Rect } from '../layout.js';
import type { Theme } from '../theme.js';

export interface DerivedDrawInput {
  readonly series: DerivedSeries;
  readonly plot: Rect;
  readonly theme: Theme;
  /** Bar centre in CSS px for an index into `series.bars`. */
  x(index: number): number;
  /** Price to CSS px. */
  y(price: number): number;
  readonly barSpacing: number;
  readonly from: number;
  readonly to: number;
}

function clipToPlot(ctx: CanvasRenderingContext2D, plot: Rect): void {
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
}

export function drawDerivedSeries(ctx: CanvasRenderingContext2D, input: DerivedDrawInput): void {
  const { series, plot, theme } = input;
  ctx.clearRect(0, 0, plot.left + plot.width + 1, plot.top + plot.height + 1);
  if (series.bars.length === 0) return;

  const from = Math.max(0, input.from);
  const to = Math.min(series.bars.length - 1, input.to);
  if (to < from) return;

  clipToPlot(ctx, plot);

  switch (series.style) {
    case 'candle':
    case 'hollow':
    case 'brick':
      drawBodies(ctx, input, from, to, series.style);
      break;
    case 'bar':
      drawOhlcBars(ctx, input, from, to);
      break;
    case 'polyline':
    case 'step':
      drawLine(ctx, input, from, to, series.style === 'step');
      break;
    case 'area':
      drawArea(ctx, input, from, to);
      break;
    case 'baseline':
      drawBaseline(ctx, input, from, to);
      break;
    case 'column':
      drawColumns(ctx, input, from, to);
      break;
  }

  ctx.restore();
  void theme;
}

function drawBodies(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
  style: 'candle' | 'hollow' | 'brick',
): void {
  const { series, theme } = input;
  const geometry = candleGeometry(input.barSpacing);
  const half = geometry.half;

  // Two passes grouped by colour so `fillStyle` changes twice, not once per bar.
  for (const rising of [true, false]) {
    // Wicks first, under the bodies.
    ctx.fillStyle = rising ? theme.upWick : theme.downWick;
    for (let i = from; i <= to; i++) {
      const bar = series.bars[i];
      if (bar.rising !== rising) continue;
      if (style === 'brick') continue; // bricks have no wick
      const xc = snapFill(input.x(i));
      const wick = vspan(input.y(bar.h), input.y(bar.l));
      ctx.fillRect(xc, wick.top, 1, wick.height);
    }

    const bodyColor = rising ? theme.upBody : theme.downBody;
    ctx.fillStyle = bodyColor;
    ctx.strokeStyle = bodyColor;
    for (let i = from; i <= to; i++) {
      const bar = series.bars[i];
      if (bar.rising !== rising) continue;
      const xc = snapFill(input.x(i));
      const body = vspan(input.y(bar.o), input.y(bar.c));
      const top = body.top;
      const height = body.height;
      const left = xc - half;
      const width = Math.max(1, geometry.width);

      if (geometry.mode === 'line' && style !== 'brick') {
        ctx.fillRect(xc, top, 1, height);
        continue;
      }
      if (style === 'hollow' && rising) {
        // Outline only: the fill would hide the wick crossing the body.
        ctx.strokeRect(snapLine(left), snapLine(top), width - 1, height - 1);
        continue;
      }
      ctx.fillRect(left, top, width, height);
    }
  }
}

/**
 * A vertical rect from two projected prices, ordered by PIXEL rather than by price.
 *
 * Under §2.1 inversion Y(high) sits below Y(low), so "top = y(high)" produces a negative
 * height that Math.max(1, …) then quietly renders as a 1px stub. Ordering here keeps
 * every derived chart type correct whichever way up the axis is.
 */
function vspan(a: number, b: number): { readonly top: number; readonly height: number } {
  const top = snapFill(a < b ? a : b);
  const bottom = snapFill(a < b ? b : a);
  return { top, height: Math.max(1, bottom - top) };
}

function drawOhlcBars(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
): void {
  const { series, theme } = input;
  const tick = Math.max(1, Math.floor(input.barSpacing * 0.35));

  for (const rising of [true, false]) {
    ctx.fillStyle = rising ? theme.upBody : theme.downBody;
    for (let i = from; i <= to; i++) {
      const bar = series.bars[i];
      if (bar.rising !== rising) continue;
      const xc = snapFill(input.x(i));
      const wick = vspan(input.y(bar.h), input.y(bar.l));
      ctx.fillRect(xc, wick.top, 1, wick.height);
      ctx.fillRect(xc - tick, snapFill(input.y(bar.o)), tick, 1);
      ctx.fillRect(xc, snapFill(input.y(bar.c)), tick, 1);
    }
  }
}

function tracePath(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
  step: boolean,
): void {
  ctx.beginPath();
  let started = false;
  let previousY = 0;
  for (let i = from; i <= to; i++) {
    const x = snapLine(input.x(i));
    const y = snapLine(input.y(input.series.bars[i].c));
    if (!started) {
      ctx.moveTo(x, y);
      started = true;
    } else if (step) {
      ctx.lineTo(x, previousY);
      ctx.lineTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
    previousY = y;
  }
}

function drawLine(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
  step: boolean,
): void {
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = input.theme.upBody;
  tracePath(ctx, input, from, to, step);
  ctx.stroke();
}

function drawArea(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
): void {
  const floor = input.plot.top + input.plot.height;
  tracePath(ctx, input, from, to, false);
  const gradient = ctx.createLinearGradient(0, input.plot.top, 0, floor);
  gradient.addColorStop(0, input.theme.upBody);
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.lineTo(snapLine(input.x(to)), floor);
  ctx.lineTo(snapLine(input.x(from)), floor);
  ctx.closePath();
  ctx.globalAlpha = 0.25;
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.lineWidth = 1.5;
  ctx.strokeStyle = input.theme.upBody;
  tracePath(ctx, input, from, to, false);
  ctx.stroke();
}

function drawBaseline(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
): void {
  const base = input.series.baseline ?? input.series.bars[from].c;
  const baseY = snapLine(input.y(base));

  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = input.theme.gridLine;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(input.plot.left, baseY);
  ctx.lineTo(input.plot.left + input.plot.width, baseY);
  ctx.stroke();
  ctx.setLineDash([]);

  // Split the fill at the baseline: above is "up" coloured, below is "down".
  for (const above of [true, false]) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(
      input.plot.left,
      above ? input.plot.top : baseY,
      input.plot.width,
      above ? baseY - input.plot.top : input.plot.top + input.plot.height - baseY,
    );
    ctx.clip();

    tracePath(ctx, input, from, to, false);
    ctx.lineTo(snapLine(input.x(to)), baseY);
    ctx.lineTo(snapLine(input.x(from)), baseY);
    ctx.closePath();
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = above ? input.theme.upBody : input.theme.downBody;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.lineWidth = 1.5;
    ctx.strokeStyle = above ? input.theme.upBody : input.theme.downBody;
    tracePath(ctx, input, from, to, false);
    ctx.stroke();
    ctx.restore();
  }
}

function drawColumns(
  ctx: CanvasRenderingContext2D,
  input: DerivedDrawInput,
  from: number,
  to: number,
): void {
  const geometry = candleGeometry(input.barSpacing);
  const floor = input.plot.top + input.plot.height;
  for (const rising of [true, false]) {
    ctx.fillStyle = rising ? input.theme.upVolume : input.theme.downVolume;
    for (let i = from; i <= to; i++) {
      const bar = input.series.bars[i];
      if (bar.rising !== rising) continue;
      const top = snapFill(input.y(bar.c));
      ctx.fillRect(snapFill(input.x(i)) - geometry.half, top, Math.max(1, geometry.width), Math.max(1, floor - top));
    }
  }
}
