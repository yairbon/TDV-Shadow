/**
 * Crosshair layer — RENDER_ALGORITHMS §10.
 *
 *     i = round(X⁻¹(xMouse))        // snap x to the nearest bar centre
 *     draw the vertical rule at snapLine(X(i))
 *     y follows the raw pointer; the price tag shows Y⁻¹(yMouse)
 *
 * This is the only layer that redraws on pointer move, which is why it owns its own
 * canvas: a pointer move never repaints candles.
 */

import { asBarIndex, asPixel } from '../../data/types.js';
import type { FrameInput } from '../frame.js';
import { rectBottom, rectContains, rectRight, type Rect } from '../layout.js';
import { snapFill, snapLine } from '../pixel.js';
import { formatCrosshairTime, formatPercent, formatPrice } from '../scale/ticks.js';

/** Boxed axis tag, kept wholly inside `bounds` however close to the edge the cursor is. */
function drawTag(
  ctx: CanvasRenderingContext2D,
  f: FrameInput,
  text: string,
  centreX: number,
  centreY: number,
  bounds: Rect,
): void {
  const d = f.theme.density;
  const width = snapFill(ctx.measureText(text).width + d.labelPaddingX * 2);
  const height = d.axisLabelHeight;
  const maxLeft = rectRight(bounds) - width;
  const maxTop = rectBottom(bounds) - height;
  const left = snapFill(Math.min(Math.max(centreX - width / 2, bounds.left), Math.max(maxLeft, bounds.left)));
  const top = snapFill(Math.min(Math.max(centreY - height / 2, bounds.top), Math.max(maxTop, bounds.top)));

  ctx.fillStyle = f.theme.labelBackground;
  ctx.fillRect(left, top, width, height);
  ctx.fillStyle = f.theme.labelText;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + width / 2, top + height / 2);
}

export function drawCrosshairLayer(ctx: CanvasRenderingContext2D, f: FrameInput): void {
  const view = f.layout.viewport;
  ctx.clearRect(0, 0, view.width, view.height);

  const pointer = f.pointer;
  if (pointer === null) return;
  const content = f.layout.content;
  if (!rectContains(content, pointer.x, pointer.y)) return;

  const bars = f.snapshot.series.bars;
  const theme = f.theme;

  // §10: snap x to the nearest bar centre; fall back to the raw pointer x when the
  // series is empty so the crosshair still tracks.
  let verticalX = snapLine(pointer.x);
  let stamp: number | null = null;
  if (!f.visible.isEmpty) {
    const raw = Math.round(f.timeScale.indexAt(asPixel(pointer.x)));
    const index = Math.min(Math.max(raw, f.visible.from), f.visible.to);
    verticalX = snapLine(f.timeScale.x(asBarIndex(index)));
    stamp = bars[index].t;
  }
  const horizontalY = snapLine(pointer.y);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = theme.crosshairLine;
  ctx.setLineDash(theme.crosshairDash.slice());
  ctx.beginPath();
  ctx.moveTo(verticalX, snapFill(content.top));
  ctx.lineTo(verticalX, snapFill(rectBottom(content)));
  ctx.moveTo(snapFill(content.left), horizontalY);
  ctx.lineTo(snapFill(rectRight(content)), horizontalY);
  ctx.stroke();
  ctx.restore();

  ctx.font = theme.typography.font;

  const gutter = f.layout.priceGutter;
  const plot = f.layout.plot;
  if (gutter.width > 0 && pointer.y >= plot.top && pointer.y <= rectBottom(plot)) {
    const price = f.priceScale.price(asPixel(pointer.y));
    const text =
      f.priceScale.mode === 'percent'
        ? formatPercent(f.priceScale, price)
        : formatPrice(price, f.pricePrecision);
    drawTag(ctx, f, text, gutter.left + gutter.width / 2, pointer.y, gutter);
  }

  const timeGutter = f.layout.timeGutter;
  if (timeGutter.height > 0 && stamp !== null) {
    drawTag(
      ctx,
      f,
      formatCrosshairTime(stamp, f.timeframeMs, f.timeZone),
      verticalX,
      timeGutter.top + timeGutter.height / 2,
      timeGutter,
    );
  }
}
