/**
 * Overlay layer: indicator lines and horizontal price lines.
 *
 * Clears itself first (SKILL rule 2) and clips to the plot rect (rule 8) so an
 * indicator can never bleed into the axis gutters. Axis-gutter tags for price lines
 * are drawn after the clip is released.
 */

import { asBarIndex, asPrice, type BarIndex, type Price } from '../../data/types.js';
import type { FrameInput } from '../frame.js';
import { rectRight } from '../layout.js';
import { snapFill, snapLine, snapStroke } from '../pixel.js';
import { makePriceRange, type PriceRange } from '../scale/priceScale.js';

/** A value per bar, index-aligned with `series.bars`. `null` is a gap (MA warm-up). */
export interface LineOverlay {
  readonly kind: 'line';
  readonly color: string;
  readonly lineWidth: number;
  readonly values: readonly (number | null)[];
}

export interface PriceLineOverlay {
  readonly kind: 'priceLine';
  readonly color: string;
  readonly lineWidth: number;
  readonly price: Price;
  readonly dash: readonly number[];
  /** Drawn as a tag in the price gutter; empty string suppresses the tag. */
  readonly label: string;
}

export type Overlay = LineOverlay | PriceLineOverlay;

/**
 * Visible extent of the overlays, folded into autoscale by §4
 * ("including visible overlay/indicator extents"). Null when nothing is visible.
 */
export function overlayPriceExtent(
  overlays: readonly Overlay[],
  from: BarIndex,
  to: BarIndex,
): PriceRange | null {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;

  for (const overlay of overlays) {
    if (overlay.kind === 'priceLine') {
      if (overlay.price < min) min = overlay.price;
      if (overlay.price > max) max = overlay.price;
      continue;
    }
    const values = overlay.values;
    const last = Math.min(to, values.length - 1);
    for (let i: number = from; i <= last; i++) {
      const v = values[i];
      if (v === null || !Number.isFinite(v)) continue;
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return null;
  return makePriceRange(min, max);
}

function drawLineOverlay(ctx: CanvasRenderingContext2D, f: FrameInput, overlay: LineOverlay): void {
  const values = overlay.values;
  const from: number = f.visible.from;
  const to = Math.min(f.visible.to, values.length - 1);
  if (to < from) return;

  const width = overlay.lineWidth;
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = width;
  ctx.beginPath();

  let open = false;
  for (let i = from; i <= to; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) {
      open = false;
      continue;
    }
    const price = asPrice(v);
    if (!f.priceScale.accepts(price)) {
      open = false;
      continue;
    }
    // x snaps to the bar centre; y stays sub-pixel so a sloped indicator line is
    // smooth instead of stair-stepped. Rule 5's half-pixel offset governs
    // axis-aligned 1px strokes, which is what `snapStroke` handles below.
    const x = snapStroke(f.timeScale.x(asBarIndex(i)), width);
    const y: number = f.priceScale.y(price);
    if (open) {
      ctx.lineTo(x, y);
    } else {
      ctx.moveTo(x, y);
      open = true;
    }
  }
  ctx.stroke();
}

function drawPriceLine(ctx: CanvasRenderingContext2D, f: FrameInput, overlay: PriceLineOverlay): void {
  if (!f.priceScale.accepts(overlay.price)) return;
  const y = snapStroke(f.priceScale.y(overlay.price), overlay.lineWidth);
  ctx.strokeStyle = overlay.color;
  ctx.lineWidth = overlay.lineWidth;
  ctx.setLineDash(overlay.dash.slice());
  ctx.beginPath();
  ctx.moveTo(snapFill(f.layout.plot.left), y);
  ctx.lineTo(snapFill(rectRight(f.layout.plot)), y);
  ctx.stroke();
  ctx.setLineDash([]);
}

function drawPriceLineTag(
  ctx: CanvasRenderingContext2D,
  f: FrameInput,
  overlay: PriceLineOverlay,
): void {
  if (overlay.label === '' || !f.priceScale.accepts(overlay.price)) return;
  const gutter = f.layout.priceGutter;
  if (gutter.width <= 0) return;
  const y: number = f.priceScale.y(overlay.price);
  if (y < f.layout.plot.top || y > f.layout.plot.top + f.layout.plot.height) return;

  const d = f.theme.density;
  const h = d.axisLabelHeight;
  const top = snapFill(y - h / 2);
  ctx.fillStyle = overlay.color;
  ctx.fillRect(snapFill(gutter.left), top, snapFill(gutter.width), h);
  ctx.fillStyle = f.theme.labelText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(overlay.label, snapFill(gutter.left) + d.labelPaddingX, snapLine(y));
}

/** Draws every overlay. `f.overlays` is empty on a chart with no indicators. */
export function drawOverlayLayer(ctx: CanvasRenderingContext2D, f: FrameInput): void {
  const view = f.layout.viewport;
  ctx.clearRect(0, 0, view.width, view.height);
  if (f.overlays.length === 0 || f.visible.isEmpty) return;

  const plot = f.layout.plot;
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left, plot.top, plot.width, plot.height);
  ctx.clip();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);

  for (const overlay of f.overlays) {
    if (overlay.kind === 'line') {
      drawLineOverlay(ctx, f, overlay);
    } else {
      drawPriceLine(ctx, f, overlay);
    }
  }
  ctx.restore();

  ctx.font = f.theme.typography.font;
  for (const overlay of f.overlays) {
    if (overlay.kind === 'priceLine') drawPriceLineTag(ctx, f, overlay);
  }
}
