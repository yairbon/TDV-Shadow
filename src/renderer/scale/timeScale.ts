/**
 * Bar index -> X, plus zoom/pan and the candle-width invariant.
 *
 * Implements RENDER_ALGORITHMS §5 and §6 exactly as written. Index space is
 * uniform: sessions and gaps consume no width, so x is linear in the *index*,
 * never in wall-clock time.
 */

import { asBarIndex, asPixel, type BarIndex, type Pixel } from '../../data/types.js';
import type { Rect } from '../layout.js';

/** §5 zoom clamps. */
export const MIN_BAR_SPACING = 0.5;
export const MAX_BAR_SPACING = 120;

/** Below this spacing a body cannot be drawn without touching its neighbour (§6). */
export const MIN_BODY_SPACING = 3;

export interface VisibleRange {
  /** First visible bar, clamped to [0, n-1]. */
  readonly from: BarIndex;
  /** Last visible bar, inclusive, clamped to [0, n-1]. */
  readonly to: BarIndex;
  /** True when the series is empty or entirely scrolled out of the plot. */
  readonly isEmpty: boolean;
  /** Number of bars in [from, to]; 0 when empty. */
  readonly count: number;
}

export interface TimeScale {
  /** `s` — CSS px per bar. */
  readonly barSpacing: number;
  /** `k` — fractional bar index at the plot's RIGHT edge. */
  readonly scrollPosition: number;
  /** `P.l` */
  readonly left: Pixel;
  /** `P.w` */
  readonly width: Pixel;
  /** X(i) — bar CENTRE in CSS px. Never clamped. */
  x(i: BarIndex): Pixel;
  /** X-inverse — fractional bar index at a pixel. */
  indexAt(x: Pixel): number;
  /** Inclusive visible index range, clamped to [0, n-1]. */
  visibleRange(barCount: number): VisibleRange;
}

export function clampBarSpacing(s: number): number {
  if (!Number.isFinite(s)) return MIN_BAR_SPACING;
  return Math.min(Math.max(s, MIN_BAR_SPACING), MAX_BAR_SPACING);
}

export function makeTimeScale(scrollPosition: number, barSpacing: number, plot: Rect): TimeScale {
  const left: number = plot.left;
  const width: number = plot.width;
  const right = left + width;
  const s = clampBarSpacing(barSpacing);
  const k = scrollPosition;

  const x = (i: BarIndex): Pixel => asPixel(right - (k - i) * s);
  const indexAt = (px: Pixel): number => k - (right - px) / s;

  return Object.freeze({
    barSpacing: s,
    scrollPosition: k,
    left: plot.left,
    width: plot.width,
    x,
    indexAt,
    visibleRange: (barCount: number): VisibleRange => {
      if (barCount <= 0) {
        return Object.freeze({
          from: asBarIndex(0),
          to: asBarIndex(-1),
          isEmpty: true,
          count: 0,
        });
      }
      // §5: i0 = max(0, floor(X⁻¹(P.l))), i1 = min(n-1, ceil(X⁻¹(P.l + P.w)))
      const last = barCount - 1;
      const rawFrom = Math.floor(indexAt(asPixel(left)));
      const rawTo = Math.ceil(indexAt(asPixel(right)));
      const from = Math.max(0, Math.min(rawFrom, last));
      const to = Math.min(last, Math.max(rawTo, 0));
      const isEmpty = rawTo < 0 || rawFrom > last || to < from;
      return Object.freeze({
        from: asBarIndex(from),
        to: asBarIndex(to),
        isEmpty,
        count: isEmpty ? 0 : to - from + 1,
      });
    },
  });
}

/** The two numbers the view store owns; a zoom or pan produces a new pair. */
export interface ViewTransform {
  readonly scrollPosition: number;
  readonly barSpacing: number;
}

/**
 * §5 zoom about an anchor pixel, keeping the bar under the cursor fixed:
 *
 *     ia = X⁻¹(xa);  s' = clamp(s * z, sMin, sMax);  k' = ia + (P.l + P.w - xa) / s'
 *
 * Pure: hand the result to the view store, do not mutate the scale.
 */
export function zoomAbout(scale: TimeScale, anchorX: Pixel, factor: number): ViewTransform {
  const right: number = scale.left + scale.width;
  const ia = scale.indexAt(anchorX);
  const s = clampBarSpacing(scale.barSpacing * factor);
  return Object.freeze({ scrollPosition: ia + (right - anchorX) / s, barSpacing: s });
}

/** §5 pan: `k' = k - dx / s` (drag right -> dx > 0 -> reveals older bars). */
export function panBy(scale: TimeScale, dx: number): ViewTransform {
  return Object.freeze({
    scrollPosition: scale.scrollPosition - dx / scale.barSpacing,
    barSpacing: scale.barSpacing,
  });
}

/**
 * §6 candle body width.
 *
 *     bw0 = floor(s * 0.8)
 *     bw  = max(1, min(bw0, floor(s) - 1))   // enforce >= 1px gap
 *     if (bw % 2 === 0) bw -= 1              // odd width centres the 1px wick
 *     if (bw < 1) bw = 1
 *
 * Guarantees `X(i+1) - bw/2 >= X(i) + bw/2 + 1` for every `s >= 2`. Below 2px of
 * spacing a 1px mark is the hardware floor, which is exactly why §6 switches to a
 * high/low line at `s < 3`.
 */
export function candleBodyWidth(s: number): number {
  const bw0 = Math.floor(s * 0.8);
  let bw = Math.max(1, Math.min(bw0, Math.floor(s) - 1));
  if (bw % 2 === 0) bw -= 1;
  if (bw < 1) bw = 1;
  return bw;
}

export type CandleMode = 'body' | 'line';

export interface CandleGeometry {
  /** Body width in CSS px. Always odd, always >= 1. */
  readonly width: number;
  /** `(width - 1) / 2` — the body spans pixel columns `xc - half .. xc + half`. */
  readonly half: number;
  /** `'line'` when `s < 3`: draw the high/low line only (§6). */
  readonly mode: CandleMode;
}

export function candleGeometry(s: number): CandleGeometry {
  if (s < MIN_BODY_SPACING) {
    return Object.freeze({ width: 1, half: 0, mode: 'line' });
  }
  const width = candleBodyWidth(s);
  return Object.freeze({ width, half: (width - 1) / 2, mode: 'body' });
}
