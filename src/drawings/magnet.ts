/**
 * Magnet snapping — resolve the bar under a pixel, then snap the price to its OHLC.
 *
 * The subtlety is the WEAK threshold. It is specified in pixels (how close the cursor
 * looks to the wick) but `snapToBar` compares prices, so the threshold must be converted
 * through the live scale. A fixed price threshold would snap from half a screen away when
 * zoomed in and never snap when zoomed out — and on a log scale it would behave
 * differently at the top and bottom of the same chart.
 */

import type { Bar } from '../data/types.js';
import { snapToBar, type Anchor, type MagnetMode, type MagnetTarget } from './types.js';
import type { PriceProjector, TimeProjector } from './geometry.js';

/** Converts a pixel tolerance into a price distance at `price`, via the live scale. */
export function pixelToleranceAsPrice(
  price: number,
  pixels: number,
  projector: PriceProjector,
): number {
  const y = projector.y(price);
  const near = projector.price(y + pixels);
  return Math.abs(near - price);
}

export interface SnapResult {
  readonly anchor: Anchor;
  readonly target: MagnetTarget;
  /** Index of the bar the anchor snapped to, or -1 when out of range. */
  readonly barIndex: number;
}

/**
 * Snaps a pixel position to a data-space anchor.
 *
 * With magnet off this is a plain unproject. With magnet on, the bar index is rounded to
 * the nearest bar first — snapping price to a bar the cursor is not over produces an
 * anchor that looks attached to the wrong candle.
 */
export function snapPixel(
  x: number,
  y: number,
  bars: readonly Bar[],
  mode: MagnetMode,
  price: PriceProjector,
  time: TimeProjector,
  tolerancePx = 8,
): SnapResult {
  const rawIndex = time.indexAt(x);
  const rawPrice = price.price(y);

  if (mode === 'off' || bars.length === 0) {
    return { anchor: { barIndex: rawIndex, price: rawPrice }, target: null, barIndex: -1 };
  }

  const index = Math.min(bars.length - 1, Math.max(0, Math.round(rawIndex)));
  const bar = bars[index];
  const threshold = pixelToleranceAsPrice(rawPrice, tolerancePx, price);
  const snapped = snapToBar(rawPrice, bar, mode, threshold);

  return {
    anchor: { barIndex: index, price: snapped.price },
    target: snapped.target,
    barIndex: index,
  };
}
