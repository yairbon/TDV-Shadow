/**
 * Client-side timeframe rollup: 1m -> 5m/15m/1h/4h/1d.
 *
 * The rollup is the same one TimescaleDB's continuous aggregate performs
 * server-side (ARCHITECTURE.md §3.3): first open, max high, min low, last
 * close, summed volume, bucketed by `time_bucket`. Buckets here come from
 * `alignToBarOpen`, so a client-side 1h bar and a server-side `candles_1h` row
 * carry the same `t` and can be compared directly.
 *
 * A bucket with no source bars produces no bar — index space is dense and a
 * missing period is simply absent, never a synthesised flat candle
 * (src/data/CLAUDE.md).
 */

import type { Bar, Timeframe } from '../types.js';
import { alignToBarOpen, makeBar, TIMEFRAME_MS } from '../types.js';

/** A target timeframe must be a whole multiple of the source, and not smaller. */
export function canResample(from: Timeframe, to: Timeframe): boolean {
  const source = TIMEFRAME_MS[from];
  const target = TIMEFRAME_MS[to];
  return target >= source && target % source === 0;
}

interface Bucket {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Rolls ascending `from`-bars up into `to`-bars.
 *
 * Input is expected ascending by `t` (a §3.1 invariant). A bar that goes
 * backwards is dropped rather than corrupting the bucket it lands in — the data
 * layer counts and drops, it does not throw into the render path. An
 * incompatible pair returns an empty array; check `canResample` first.
 */
export function resample(bars: readonly Bar[], from: Timeframe, to: Timeframe): readonly Bar[] {
  if (!canResample(from, to)) return Object.freeze([]);
  if (TIMEFRAME_MS[to] === TIMEFRAME_MS[from]) return bars;

  const out: Bar[] = [];
  let bucket: Bucket | null = null;
  let previousT = Number.NEGATIVE_INFINITY;

  const flush = (): void => {
    if (bucket === null) return;
    const bar = makeBar(bucket);
    if (bar !== null) out.push(bar);
    bucket = null;
  };

  for (const bar of bars) {
    if (bar.t < previousT) continue; // out of order: drop, never reorder a stream
    previousT = bar.t;

    const start = alignToBarOpen(bar.t, to);
    if (bucket === null || bucket.t !== start) {
      flush();
      bucket = { t: start, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v };
      continue;
    }

    if (bar.h > bucket.h) bucket.h = bar.h;
    if (bar.l < bucket.l) bucket.l = bar.l;
    bucket.c = bar.c;
    bucket.v += bar.v;
  }
  flush();

  return Object.freeze(out);
}

/**
 * Incremental variant for the live bar: rolls `bar` into `aggregate` when both
 * fall in the same target bucket, otherwise starts a new one. Returns a new
 * frozen Bar — `aggregate` is never mutated (root mandate #4). `null` means the
 * input was malformed and was dropped.
 */
export function foldIntoBucket(aggregate: Bar | null, bar: Bar, to: Timeframe): Bar | null {
  const start = alignToBarOpen(bar.t, to);
  if (aggregate === null || aggregate.t !== start) {
    return makeBar({ t: start, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: bar.v });
  }
  return makeBar({
    t: start,
    o: aggregate.o,
    h: Math.max(aggregate.h, bar.h),
    l: Math.min(aggregate.l, bar.l),
    c: bar.c,
    v: aggregate.v + bar.v,
  });
}
