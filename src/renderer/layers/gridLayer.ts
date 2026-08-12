/**
 * Grid + axes layer: background, gridlines, axis rules and tick labels.
 *
 * Bottom of the stack, so it also paints the chart background. Gridlines are clipped
 * to the content rect (SKILL rule 8); labels are drawn afterwards, deliberately in
 * the gutters. Every primitive here is a canvas call — an axis tick is never an
 * element (mandate #1).
 */

import { asPixel } from '../../data/types.js';
import type { FrameInput } from '../frame.js';
import { rectBottom, rectRight } from '../layout.js';
import { snapFill, snapLine } from '../pixel.js';
import { formatPercent, priceTicks, timeTicks, type PriceTick } from '../scale/ticks.js';

function drawHorizontalRule(ctx: CanvasRenderingContext2D, y: number, x0: number, x1: number): void {
  const yy = snapLine(y);
  ctx.moveTo(snapFill(x0), yy);
  ctx.lineTo(snapFill(x1), yy);
}

function drawVerticalRule(ctx: CanvasRenderingContext2D, x: number, y0: number, y1: number): void {
  const xx = snapLine(x);
  ctx.moveTo(xx, snapFill(y0));
  ctx.lineTo(xx, snapFill(y1));
}

function priceLabel(f: FrameInput, tick: PriceTick): string {
  return f.priceScale.mode === 'percent' ? formatPercent(f.priceScale, tick.price) : tick.label;
}

export function drawGridLayer(ctx: CanvasRenderingContext2D, f: FrameInput): void {
  const view = f.layout.viewport;
  const content = f.layout.content;
  const plot = f.layout.plot;
  const theme = f.theme;

  ctx.clearRect(0, 0, view.width, view.height);
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, view.width, view.height);
  if (content.width <= 0 || content.height <= 0) return;

  const ticks = priceTicks(f.priceScale, theme.typography.lineHeight, f.pricePrecision);
  const axis = timeTicks(
    f.snapshot.series.bars,
    f.visible,
    f.timeScale,
    f.timeframeMs,
    theme.density.minTimeTickSpacing,
    f.timeZone,
  );
  const times = axis.ticks;

  // --- gridlines, clipped to the content rect -------------------------------
  ctx.save();
  ctx.beginPath();
  ctx.rect(content.left, content.top, content.width, content.height);
  ctx.clip();

  if (f.showGrid) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = theme.gridLine;
    ctx.beginPath();
    for (const tick of ticks) {
      if (tick.y < plot.top || tick.y > rectBottom(plot)) continue;
      drawHorizontalRule(ctx, tick.y, plot.left, rectRight(plot));
    }
    for (const tick of times) {
      drawVerticalRule(ctx, tick.x, content.top, rectBottom(content));
    }
    ctx.stroke();
  }

  // Session separators (10.2): a calendar-day boundary in the display timezone. Drawn
  // whether or not gridlines are on — a session break is structure, not decoration, and
  // it is what tells a gap in trading apart from a gap in the data.
  if (axis.sessionBreaks.length > 0 && axis.sessionBreaks.length < content.width) {
    ctx.strokeStyle = theme.axisLine;
    ctx.beginPath();
    for (const x of axis.sessionBreaks) {
      drawVerticalRule(ctx, asPixel(x), content.top, rectBottom(content));
    }
    ctx.stroke();
  }
  ctx.restore();

  // --- axis rules -----------------------------------------------------------
  ctx.strokeStyle = theme.axisLine;
  ctx.beginPath();
  drawVerticalRule(ctx, rectRight(content), view.top, rectBottom(content));
  drawHorizontalRule(ctx, rectBottom(content), view.left, rectRight(content));
  const pane = f.layout.volume;
  if (pane !== null) {
    drawHorizontalRule(ctx, pane.top, content.left, rectRight(content));
  }
  ctx.stroke();

  // --- labels, in the gutters ----------------------------------------------
  ctx.font = theme.typography.font;
  ctx.fillStyle = theme.axisText;
  ctx.textBaseline = 'middle';

  const gutter = f.layout.priceGutter;
  if (gutter.width > 0) {
    ctx.textAlign = 'left';
    const labelX = snapFill(gutter.left) + theme.density.labelPaddingX;
    const half = theme.typography.lineHeight / 2;
    for (const tick of ticks) {
      if (tick.y - half < plot.top || tick.y + half > rectBottom(plot)) continue;
      ctx.fillText(priceLabel(f, tick), labelX, snapFill(tick.y));
    }
  }

  const timeGutter = f.layout.timeGutter;
  if (timeGutter.height > 0) {
    ctx.textAlign = 'center';
    const labelY = snapFill(timeGutter.top + timeGutter.height / 2);
    for (const tick of times) {
      const width = ctx.measureText(tick.label).width;
      const x = snapFill(tick.x);
      // Never let a label overhang the gutter into the price axis or off-canvas.
      if (x - width / 2 < content.left || x + width / 2 > rectRight(content)) continue;
      ctx.fillStyle = tick.major ? theme.axisTextStrong : theme.axisText;
      ctx.fillText(tick.label, x, labelY);
    }
  }
}
