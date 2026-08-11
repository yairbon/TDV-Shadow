/**
 * Heikin Ashi — the one 1:1 type with real math.
 *
 *   HA close = (o + h + l + c) / 4
 *   HA open  = (prev HA open + prev HA close) / 2,  seeded with (o + c) / 2
 *   HA high  = max(h, HA open, HA close)
 *   HA low   = min(l, HA open, HA close)
 *
 * The seed matters: HA is recursive, so starting it at the raw open instead of the
 * midpoint shifts every subsequent bar until the recursion damps out. It is 1:1 with
 * the input, so index space — and therefore drawings and the time axis — is unchanged.
 */

import type { Bar } from '../data/types.js';
import { makeDerived } from './shared.js';
import type { ChartTypeTransform, DerivedBar, DerivedSeries } from './types.js';

export function heikinAshiBars(bars: readonly Bar[]): DerivedBar[] {
  const out: DerivedBar[] = new Array<DerivedBar>(bars.length);
  let previousOpen = 0;
  let previousClose = 0;

  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i];
    const close = (bar.o + bar.h + bar.l + bar.c) / 4;
    const open = i === 0 ? (bar.o + bar.c) / 2 : (previousOpen + previousClose) / 2;
    const high = Math.max(bar.h, open, close);
    const low = Math.min(bar.l, open, close);
    out[i] = makeDerived(bar, i, open, high, low, close, bar.v, close >= open);
    previousOpen = open;
    previousClose = close;
  }
  return out;
}

export const heikinAshiTransform: ChartTypeTransform = {
  type: 'heikin-ashi',
  style: 'candle',
  preservesIndexSpace: true,
  // `params` is omitted rather than named-and-ignored: TypeScript accepts an
  // implementation with fewer parameters, and the lint config has no underscore escape.
  transform(bars: readonly Bar[]): DerivedSeries {
    return Object.freeze<DerivedSeries>({
      type: 'heikin-ashi',
      style: 'candle',
      bars: Object.freeze(heikinAshiBars(bars)),
      preservesIndexSpace: true,
      baseline: null,
    });
  },
};
