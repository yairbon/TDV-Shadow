/**
 * Shared numeric kernels for the indicator suite.
 *
 * Rules every helper here obeys, so the indicators themselves stay short:
 *
 * 1. **Warm-up is `NaN`, never 0.** Output buffers arrive NaN-filled (`nanArray`) and a
 *    kernel writes only the indices it can actually compute. A kernel with too little
 *    input writes nothing and the caller returns an all-NaN plot — an indicator that
 *    emits 0 before it is formed draws a cliff that looks like real data.
 * 2. **One allocation per plot per compute.** Kernels write into a caller-owned
 *    `Float64Array`; nothing allocates per bar (SKILL.md performance budget).
 * 3. **Total.** No kernel throws. Degenerate periods, empty input and short input are
 *    ordinary control flow, not errors.
 *
 * `offset` on the windowed kernels is the index of the first usable input sample. It
 * exists so an indicator can be stacked on another indicator's output — MACD's signal is
 * an EMA of the MACD line, which is itself NaN until the slow EMA is formed, and feeding
 * those NaNs into the seed would poison every later value.
 */

import type { Bar } from '../data/types.js';
import type { IndicatorParams } from './types.js';
import { sourceValue } from './types.js';

/** A NaN-filled buffer. Every plot starts here; kernels only overwrite real values. */
export function nanArray(length: number): Float64Array {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
}

/**
 * Coerces a user-supplied period to a usable integer. Non-finite, fractional-to-zero,
 * zero and negative periods fall back to the indicator's default rather than throwing or
 * silently producing a degenerate 1-bar window.
 */
export function normalizePeriod(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw)) return fallback;
  const period = Math.floor(raw);
  return period < 1 ? fallback : period;
}

/** Coerces a positive non-integer parameter (Bollinger's stdDev, value-area percent). */
export function normalizeFactor(raw: number | undefined, fallback: number): number {
  if (raw === undefined || !Number.isFinite(raw) || raw <= 0) return fallback;
  return raw;
}

/** Projects bars onto the configured price source, one allocation. */
export function extractSource(
  bars: readonly Bar[],
  source: IndicatorParams['source'],
): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) out[i] = sourceValue(bars[i], source);
  return out;
}

/**
 * Simple moving average. First value lands at `offset + period - 1`; everything before it
 * is left as the caller's NaN.
 */
export function smaInto(
  src: Float64Array,
  period: number,
  out: Float64Array,
  offset = 0,
): void {
  const n = src.length;
  if (period < 1 || offset < 0 || n - offset < period) return;

  let sum = 0;
  for (let i = offset; i < offset + period; i += 1) sum += src[i];
  out[offset + period - 1] = sum / period;

  for (let i = offset + period; i < n; i += 1) {
    sum += src[i] - src[i - period];
    out[i] = sum / period;
  }
}

/**
 * Exponential moving average seeded from the SMA of the first `period` samples, then
 * `k = 2 / (period + 1)`. Seeding from the SMA rather than from the first sample is what
 * keeps the first plotted point from being an outlier that decays visibly for 30 bars.
 */
export function emaInto(
  src: Float64Array,
  period: number,
  out: Float64Array,
  offset = 0,
): void {
  const n = src.length;
  if (period < 1 || offset < 0 || n - offset < period) return;

  let sum = 0;
  for (let i = offset; i < offset + period; i += 1) sum += src[i];
  let prev = sum / period;
  out[offset + period - 1] = prev;

  const k = 2 / (period + 1);
  for (let i = offset + period; i < n; i += 1) {
    prev = (src[i] - prev) * k + prev;
    out[i] = prev;
  }
}

/**
 * Wilder's smoothing: seed with the mean of the first `period` samples, then
 * `avg += (x - avg) / period`. This is NOT `emaInto` with the same period — Wilder's
 * factor is `1 / period` where an EMA's is `2 / (period + 1)`, and on RSI(14) the
 * difference between 1/14 and 2/15 is plainly visible on the chart.
 */
export function wilderInto(
  src: Float64Array,
  period: number,
  out: Float64Array,
  offset = 0,
): void {
  const n = src.length;
  if (period < 1 || offset < 0 || n - offset < period) return;

  let sum = 0;
  for (let i = offset; i < offset + period; i += 1) sum += src[i];
  let avg = sum / period;
  out[offset + period - 1] = avg;

  for (let i = offset + period; i < n; i += 1) {
    avg += (src[i] - avg) / period;
    out[i] = avg;
  }
}

/**
 * Linearly weighted moving average: weight `j` for the `j`-th newest-to-oldest sample.
 * Computed window-at-a-time rather than by the rolling-numerator trick — the rolling form
 * accumulates drift over thousands of bars, and indicators are memoised off-frame, so the
 * O(n·period) cost is not on the frame budget.
 */
export function wmaInto(src: Float64Array, period: number, out: Float64Array): void {
  const n = src.length;
  if (period < 1 || n < period) return;

  const denominator = (period * (period + 1)) / 2;
  for (let i = period - 1; i < n; i += 1) {
    let acc = 0;
    for (let j = 0; j < period; j += 1) acc += src[i - period + 1 + j] * (j + 1);
    out[i] = acc / denominator;
  }
}

/**
 * Population standard deviation over the same rolling window as `means`, which must
 * already hold the SMA of `src` for that window. Population (÷ N), not sample (÷ N−1):
 * Bollinger's bands are defined over the window as the whole population.
 *
 * Two-pass per window against the known mean instead of the `E[x²] − E[x]²` shortcut,
 * which cancels catastrophically when the window's variance is tiny next to the square of
 * a five-figure price.
 */
export function stdDevInto(
  src: Float64Array,
  means: Float64Array,
  period: number,
  out: Float64Array,
): void {
  const n = src.length;
  if (period < 1 || n < period) return;

  for (let i = period - 1; i < n; i += 1) {
    const mean = means[i];
    let acc = 0;
    for (let j = i - period + 1; j <= i; j += 1) {
      const d = src[j] - mean;
      acc += d * d;
    }
    out[i] = Math.sqrt(acc / period);
  }
}

/** Number of leading NaNs — the formed-from index of a plot. */
export function leadingNaNCount(values: Float64Array): number {
  let count = 0;
  while (count < values.length && Number.isNaN(values[count])) count += 1;
  return count;
}

/**
 * Widens a degenerate price range so downstream division is safe, using the same
 * expansion the renderer applies (RENDER_ALGORITHMS §2, SKILL rule 9). Returns the input
 * untouched when the range is already non-degenerate.
 */
export function expandDegenerateRange(min: number, max: number): readonly [number, number] {
  if (max - min >= Math.max(Math.abs(max) * 1e-9, 1e-12)) return [min, max];
  const d = Math.max(Math.abs(max) * 1e-4, 1e-8);
  return [min - d, max + d];
}
