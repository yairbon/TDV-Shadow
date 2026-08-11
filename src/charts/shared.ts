/**
 * Helpers shared by every chart-type transform.
 *
 * `makeDerived` is the ONLY way a DerivedBar is constructed. It enforces the OHLC
 * invariants and freezes, so a transform cannot emit a bar the renderer would draw
 * upside-down — a Renko brick with `h < l` produces a negative-height rect that the
 * §7 `max(1, …)` floor silently turns into a 1px line rather than an obvious failure.
 */

import { asPrice, type Bar } from '../data/types.js';
import type { DerivedBar } from './types.js';

export function makeDerived(
  source: Bar,
  sourceIndex: number,
  o: number,
  h: number,
  l: number,
  c: number,
  v: number,
  rising: boolean,
): DerivedBar {
  // Repair rather than trust: `h`/`l` are recomputed from the extremes so a caller
  // that forgets to widen them cannot produce an inverted bar.
  const high = Math.max(h, o, c);
  const low = Math.min(l, o, c);
  return Object.freeze<DerivedBar>({
    t: source.t,
    o: asPrice(o),
    h: asPrice(high),
    l: asPrice(low),
    c: asPrice(c),
    v,
    sourceIndex,
    rising,
  });
}

/** Identity mapping: one derived bar per input bar, unchanged values. */
export function passthrough(bars: readonly Bar[]): DerivedBar[] {
  const out: DerivedBar[] = new Array<DerivedBar>(bars.length);
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    out[i] = makeDerived(bar, i, bar.o, bar.h, bar.l, bar.c, bar.v, bar.c >= bar.o);
  }
  return out;
}

/**
 * Wilder's ATR, used to size Renko and Range bricks when no explicit size is given.
 * Returns 0 for input shorter than `period + 1`, and callers must treat 0 as
 * "cannot size bricks" rather than dividing by it.
 */
export function atr(bars: readonly Bar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    sum += trueRange(bars[i], bars[i - 1]);
  }
  let value = sum / period;
  for (let i = period + 1; i < bars.length; i++) {
    value = (value * (period - 1) + trueRange(bars[i], bars[i - 1])) / period;
  }
  return value;
}

export function trueRange(bar: Bar, previous: Bar): number {
  return Math.max(bar.h - bar.l, Math.abs(bar.h - previous.c), Math.abs(bar.l - previous.c));
}

/** Resolves a configured brick size, falling back to ATR and then to a price fraction. */
export function resolveBrickSize(bars: readonly Bar[], configured: number | null | undefined): number {
  if (configured !== null && configured !== undefined && configured > 0) return configured;
  const derivedSize = atr(bars, 14);
  if (derivedSize > 0) return derivedSize;
  // Last resort for very short series: 1% of the last close keeps bricks meaningful
  // instead of collapsing to zero and looping forever.
  if (bars.length === 0) return 0;
  return Math.abs(bars[bars.length - 1].c) * 0.01;
}
