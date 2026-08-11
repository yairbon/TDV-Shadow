/**
 * Deterministic bar source for local dev and visual regression.
 *
 * The real transport is `src/data/ws/client.ts` + `src/data/rest/history.ts`; this is
 * a seeded generator standing in for a gateway that does not exist yet. It matters for
 * Phase 3: `tests/visual/README.md` requires bit-deterministic fixtures, so the seed
 * fully determines every bar — no `Math.random`, no wall clock.
 */

import { makeBar, TIMEFRAME_MS, type Bar, type Timeframe } from '../data/types.js';

export interface FeedOptions {
  readonly seed: number;
  readonly count: number;
  readonly tf: Timeframe;
  /** First bar's open time, UTC ms. Fixed by default so runs are reproducible. */
  readonly startMs?: number;
  readonly startPrice?: number;
}

/** Epoch of the default fixture: 2025-08-11T00:00:00Z. */
export const FIXTURE_START_MS = 1_754_870_400_000;

/** Numerical Recipes LCG — small, fast, and identical across engines. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return (): number => {
    s = (Math.imul(s, 1_664_525) + 1_013_904_223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

export function generateBars(o: FeedOptions): Bar[] {
  const rnd = lcg(o.seed);
  const step = TIMEFRAME_MS[o.tf];
  const start = o.startMs ?? FIXTURE_START_MS;
  const bars: Bar[] = [];
  let price = o.startPrice ?? 100;

  for (let i = 0; i < o.count; i++) {
    const open = price;
    const drift = (rnd() - 0.495) * 0.018;
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + rnd() * 0.006);
    const low = Math.min(open, close) * (1 - rnd() * 0.006);
    const bar = makeBar({
      t: start + i * step,
      o: open,
      h: high,
      l: low,
      c: close,
      v: Math.floor(rnd() * 1_000) + 1,
    });
    // makeBar only returns null on invariant violation; the generator cannot produce one.
    if (bar === null) throw new Error(`generateBars produced an invalid bar at index ${String(i)}`);
    bars.push(bar);
    price = close;
  }
  return bars;
}

/** Produces the next live tick for the open bar — a new frozen object, never a mutation. */
export function nextTick(last: Bar, rnd: () => number): Bar | null {
  const close = last.c * (1 + (rnd() - 0.5) * 0.004);
  return makeBar({
    t: last.t,
    o: last.o,
    h: Math.max(last.h, close),
    l: Math.min(last.l, close),
    c: close,
    v: last.v + Math.floor(rnd() * 5),
  });
}

export { lcg };
