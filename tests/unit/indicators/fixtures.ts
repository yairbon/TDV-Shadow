/**
 * Shared bar fixtures for the indicator specs.
 *
 * Deliberately tiny and hand-writable: every expected value in these specs was worked out
 * on paper from these bars, not read back out of the implementation.
 */

import { makeBar, type Bar } from '../../../src/data/types.js';

const START = 1_754_870_400_000;
const STEP = 60_000;

/** One bar, index-stamped so `t` stays a strictly increasing UTC epoch-ms open time. */
export function bar(i: number, o: number, h: number, l: number, c: number, v = 100): Bar {
  const made = makeBar({ t: START + i * STEP, o, h, l, c, v });
  if (made === null) throw new Error(`invalid fixture bar ${String(i)}`);
  return made;
}

/** Bars built from OHLCV rows, index-stamped in order. */
export function bars(
  rows: readonly (readonly [number, number, number, number, number])[],
): Bar[] {
  return rows.map((row, i) => bar(i, row[0], row[1], row[2], row[3], row[4]));
}

/** Deterministic noisy series, for range and monotonicity properties. */
export function wiggle(n: number): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 3) * 2 + Math.cos(i / 7);
    const close = price + drift;
    out.push(bar(i, price, Math.max(price, close) + 1, Math.min(price, close) - 1, close, 50 + i));
    price = close;
  }
  return out;
}

/** Strictly rising series: open, high, low and close all advance by `step` each bar. */
export function rising(n: number, start = 100, step = 1): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const open = start + i * step;
    const close = open + step;
    return bar(i, open, close + 0.25, open - 0.25, close);
  });
}

/** Strictly falling series. */
export function falling(n: number, start = 200, step = 1): Bar[] {
  return Array.from({ length: n }, (_, i) => {
    const open = start - i * step;
    const close = open - step;
    return bar(i, open, open + 0.25, close - 0.25, close);
  });
}

/** Leading-NaN count of a plot — the index its first real value lands on. */
export function leadingNaN(values: Float64Array): number {
  let n = 0;
  while (n < values.length && Number.isNaN(values[n])) n += 1;
  return n;
}
