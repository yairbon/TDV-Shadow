/**
 * Price -> Y and Y -> price.
 *
 * Implements RENDER_ALGORITHMS §2 (linear), §3 (log / percent) and §4 (autoscale)
 * exactly as written. Do not re-derive these terms: the doc is normative, this file
 * is the code that obeys it.
 */

import { asPixel, asPrice, type Bar, type BarIndex, type Pixel, type Price } from '../../data/types.js';
import type { PriceScaleMode } from '../../data/types.js';
import type { Rect } from '../layout.js';

export interface PriceRange {
  readonly min: Price;
  readonly max: Price;
}

export function makePriceRange(min: number, max: number): PriceRange {
  return Object.freeze({ min: asPrice(min), max: asPrice(max) });
}

/** Log/percent geometry is undefined at or below zero (§3); this is the floor used. */
export const MIN_LOG_PRICE = 1e-12;

export interface ExpandedRange {
  readonly min: number;
  readonly max: number;
}

/**
 * §2 degenerate-range guard, applied before any transform is built:
 *
 *     if (pMax - pMin < eps)  with eps = max(|pMax| * 1e-9, 1e-12)
 *       pMax += d, pMin -= d  with d   = max(|pMax| * 1e-4, 1e-8)
 *
 * Works on plain numbers so the identical guard can be reused in log space.
 */
export function expandDegenerate(min: number, max: number): ExpandedRange {
  const eps = Math.max(Math.abs(max) * 1e-9, 1e-12);
  if (max - min >= eps) return { min, max };
  const d = Math.max(Math.abs(max) * 1e-4, 1e-8);
  return { min: min - d, max: max + d };
}

export interface PriceScale {
  readonly mode: PriceScaleMode;
  /** Range actually mapped to the plot, after the §2 guard. */
  readonly min: Price;
  readonly max: Price;
  readonly top: Pixel;
  readonly height: Pixel;
  /** Percent-mode basis `p0` — the first visible bar's close (§3). */
  readonly base: Price;
  /** Y(p). Total and monotone-decreasing; never clamped — clipping is the layer's job. */
  y(p: Price): Pixel;
  /** Y-inverse. */
  price(y: Pixel): Price;
  /** False for p <= 0 on log/percent: those bars are dropped, not clamped (§3). */
  accepts(p: Price): boolean;
  /** Percent-mode display value: `(p / p0 - 1) * 100`. Geometry is unchanged (§3). */
  percentOf(p: Price): number;
}

/**
 * Builds the transform for one frame. `plot` supplies `P.t` and `P.h`; `base` is
 * ignored outside percent mode.
 */
export function makePriceScale(
  range: PriceRange,
  plot: Rect,
  mode: PriceScaleMode,
  base: Price,
): PriceScale {
  const top: number = plot.top;
  const height: number = plot.height;
  const guarded = expandDegenerate(range.min, range.max);
  const safeBase = base > 0 ? base : MIN_LOG_PRICE;

  if (mode === 'linear') {
    const pMin = guarded.min;
    const pMax = guarded.max;
    // §2: m = P.h / (pMax - pMin); Y(p) = P.t + (pMax - p) * m
    const m = height / (pMax - pMin);
    return Object.freeze({
      mode,
      min: asPrice(pMin),
      max: asPrice(pMax),
      top: plot.top,
      height: plot.height,
      base: asPrice(safeBase),
      y: (p: Price): Pixel => asPixel(top + (pMax - p) * m),
      price: (y: Pixel): Price => asPrice(pMax - (y - top) / m),
      accepts: (): boolean => true,
      percentOf: (p: Price): number => (p / safeBase - 1) * 100,
    });
  }

  // §3: the same map with L(p) = ln p substituted for p. Percent mode is this
  // geometry re-based on p0 for *labels only*.
  const lRaw = expandDegenerate(
    Math.log(Math.max(guarded.min, MIN_LOG_PRICE)),
    Math.log(Math.max(guarded.max, MIN_LOG_PRICE)),
  );
  const lMin = lRaw.min;
  const lMax = lRaw.max;
  const mLog = height / (lMax - lMin);
  return Object.freeze({
    mode,
    min: asPrice(Math.exp(lMin)),
    max: asPrice(Math.exp(lMax)),
    top: plot.top,
    height: plot.height,
    base: asPrice(safeBase),
    y: (p: Price): Pixel => asPixel(top + (lMax - Math.log(p)) * mLog),
    price: (y: Pixel): Price => asPrice(Math.exp(lMax - (y - top) / mLog)),
    accepts: (p: Price): boolean => p > 0,
    percentOf: (p: Price): number => (p / safeBase - 1) * 100,
  });
}

/**
 * §4 autoscale over the visible bars, with 10% padding top and bottom.
 *
 * `extra` folds in visible overlay/indicator extents before padding, as §4 requires.
 * Recompute this only when the visible range or the bars change — never per frame.
 */
export function autoscale(
  bars: readonly Bar[],
  from: BarIndex,
  to: BarIndex,
  extra: PriceRange | null = null,
): PriceRange {
  let rawMin = Number.POSITIVE_INFINITY;
  let rawMax = Number.NEGATIVE_INFINITY;

  for (let i: number = from; i <= to; i++) {
    const bar = bars[i];
    if (bar.l < rawMin) rawMin = bar.l;
    if (bar.h > rawMax) rawMax = bar.h;
  }

  if (extra !== null) {
    if (extra.min < rawMin) rawMin = extra.min;
    if (extra.max > rawMax) rawMax = extra.max;
  }

  if (!Number.isFinite(rawMin) || !Number.isFinite(rawMax)) {
    // Nothing visible: a unit range keeps the transform total and finite.
    return makePriceRange(0, 1);
  }

  const pad = (rawMax - rawMin) * 0.1;
  return makePriceRange(rawMin - pad, rawMax + pad);
}

/** Percent mode's `p0`: the close of the first visible bar (§3). */
export function percentBase(bars: readonly Bar[], from: BarIndex): Price {
  if (from < 0 || from >= bars.length) return asPrice(1);
  return bars[from].c;
}
