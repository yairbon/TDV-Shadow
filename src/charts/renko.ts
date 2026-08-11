/**
 * Renko and Range bars — price-driven, not time-driven.
 *
 * Both emit a different bar count from the input, so every brick records the
 * `sourceIndex` of the bar that CLOSED it. The time axis reads timestamps through that
 * mapping; without it, labels drift because brick N is not bar N.
 *
 * Renko reversal rule: continuing the trend needs one brick of movement, but reversing
 * needs two — one to erase the current brick and one to establish the new direction.
 * Implementing it as a single brick produces a zig-zag that reverses on noise, which is
 * exactly the thing Renko exists to filter out.
 */

import type { Bar } from '../data/types.js';
import { makeDerived, resolveBrickSize } from './shared.js';
import type { ChartTypeParams, ChartTypeTransform, DerivedBar, DerivedSeries } from './types.js';

/** Hard cap so a pathological brick size cannot spin the loop forever. */
const MAX_BRICKS_PER_BAR = 500;

export function renkoBars(bars: readonly Bar[], params: ChartTypeParams): DerivedBar[] {
  const out: DerivedBar[] = [];
  if (bars.length === 0) return out;

  const size = resolveBrickSize(bars, params.brickSize);
  if (!(size > 0)) return out;

  // Explicit `number`: these are working values in price space, not branded `Price`
  // reads, and the brand deliberately blocks assigning arithmetic results back.
  let anchor: number = bars[0].c;
  let direction = 0; // 0 until the first brick establishes one

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    let guard = 0;

    for (;;) {
      if (++guard > MAX_BRICKS_PER_BAR) break;

      // Reversing costs two bricks; continuing costs one.
      const upThreshold = direction < 0 ? anchor + size * 2 : anchor + size;
      const downThreshold = direction > 0 ? anchor - size * 2 : anchor - size;

      if (bar.c >= upThreshold) {
        const open = direction < 0 ? anchor + size : anchor;
        const close = open + size;
        out.push(makeDerived(bar, i, open, close, open, close, bar.v, true));
        anchor = close;
        direction = 1;
        continue;
      }
      if (bar.c <= downThreshold) {
        const open = direction > 0 ? anchor - size : anchor;
        const close = open - size;
        out.push(makeDerived(bar, i, open, open, close, close, bar.v, false));
        anchor = close;
        direction = -1;
        continue;
      }
      break;
    }
  }
  return out;
}

/** Range bars: a new bar every time price travels `brickSize`, ignoring time entirely. */
export function rangeBars(bars: readonly Bar[], params: ChartTypeParams): DerivedBar[] {
  const out: DerivedBar[] = [];
  if (bars.length === 0) return out;

  const size = resolveBrickSize(bars, params.brickSize);
  if (!(size > 0)) return out;

  let open: number = bars[0].o;
  let high: number = bars[0].h;
  let low: number = bars[0].l;
  let volume = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    high = Math.max(high, bar.h);
    low = Math.min(low, bar.l);
    volume += bar.v;

    if (high - low >= size) {
      const close = bar.c;
      out.push(makeDerived(bar, i, open, high, low, close, volume, close >= open));
      open = close;
      high = close;
      low = close;
      volume = 0;
    }
  }
  return out;
}

export const renkoTransform: ChartTypeTransform = {
  type: 'renko',
  style: 'brick',
  preservesIndexSpace: false,
  transform: (bars, params) =>
    Object.freeze<DerivedSeries>({
      type: 'renko',
      style: 'brick',
      bars: Object.freeze(renkoBars(bars, params)),
      preservesIndexSpace: false,
      baseline: null,
    }),
};

export const rangeTransform: ChartTypeTransform = {
  type: 'range',
  style: 'candle',
  preservesIndexSpace: false,
  transform: (bars, params) =>
    Object.freeze<DerivedSeries>({
      type: 'range',
      style: 'candle',
      bars: Object.freeze(rangeBars(bars, params)),
      preservesIndexSpace: false,
      baseline: null,
    }),
};
