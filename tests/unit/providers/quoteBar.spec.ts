/**
 * Folding a quote into the last bar.
 *
 * The properties worth holding: the open and the volume never move, the extremes only
 * widen, a quote from the next period is refused rather than guessed at, and a bar the
 * user is looking at is never rewritten by a quote that is older than it.
 */

import { describe, expect, it } from 'vitest';
import { applyQuote } from '../../../src/providers/quoteBar.js';
import { makeBar, type Bar, type TimeMs } from '../../../src/data/types.js';
import type { Quote } from '../../../src/providers/types.js';

const OPEN = Date.UTC(2026, 7, 13, 19, 59, 0);

function bar(fields: Partial<{ o: number; h: number; l: number; c: number; v: number }> = {}): Bar {
  const made = makeBar({
    t: OPEN,
    o: fields.o ?? 300,
    h: fields.h ?? 301,
    l: fields.l ?? 299,
    c: fields.c ?? 300.5,
    v: fields.v ?? 12_345,
  });
  if (made === null) throw new Error('fixture rejected');
  return made;
}

const quote = (price: number, at: number = OPEN + 1000): Quote => ({
  symbol: 'AAPL',
  price,
  time: at as TimeMs,
  marketOpen: true,
});

describe('a quote inside the current bar', () => {
  it('moves the close', () => {
    const result = applyQuote(bar(), quote(300.75), '1m');
    expect(result.kind).toBe('update');
    if (result.kind !== 'update') return;
    expect(result.bar.c).toBe(300.75);
  });

  it('leaves the open and the volume exactly where they were', () => {
    // A quote is a price, not a trade report. Nudging the volume would put a number on
    // the volume pane that no exchange ever published.
    const before = bar({ o: 300, v: 12_345 });
    const result = applyQuote(before, quote(305), '1m');
    if (result.kind !== 'update') throw new Error(result.kind);
    expect(result.bar.o).toBe(before.o);
    expect(result.bar.v).toBe(before.v);
  });

  it('widens the high when the price trades above it', () => {
    const result = applyQuote(bar({ h: 301 }), quote(302.5), '1m');
    if (result.kind !== 'update') throw new Error(result.kind);
    expect(result.bar.h).toBe(302.5);
    expect(result.bar.l).toBe(299);
  });

  it('widens the low when the price trades below it', () => {
    const result = applyQuote(bar({ l: 299 }), quote(297.25), '1m');
    if (result.kind !== 'update') throw new Error(result.kind);
    expect(result.bar.l).toBe(297.25);
    expect(result.bar.h).toBe(301);
  });

  it('never narrows the range back towards the close', () => {
    // The bar traded to 301 and 299; a later quote at 300 does not undo that.
    const result = applyQuote(bar({ h: 301, l: 299 }), quote(300), '1m');
    if (result.kind !== 'update') throw new Error(result.kind);
    expect(result.bar.h).toBe(301);
    expect(result.bar.l).toBe(299);
  });

  it('produces a NEW frozen object rather than touching the stored one', () => {
    // Root mandate #4: an OHLCV object is never mutated in place.
    const before = bar();
    const result = applyQuote(before, quote(302), '1m');
    if (result.kind !== 'update') throw new Error(result.kind);
    expect(result.bar).not.toBe(before);
    expect(Object.isFrozen(result.bar)).toBe(true);
    expect(before.c).toBe(300.5);
  });

  it('reports no change when the price is already the close', () => {
    // Repainting on every poll of a closed market is churn, and each repaint re-runs the
    // alert observer over a bar that did not move.
    expect(applyQuote(bar({ c: 300.5 }), quote(300.5), '1m').kind).toBe('unchanged');
  });
});

describe('a quote from beyond the current bar', () => {
  it('asks for bars rather than inventing one', () => {
    // One minute later exactly: the next bar has begun.
    expect(applyQuote(bar(), quote(302, OPEN + 60_000), '1m').kind).toBe('refetch');
  });

  it('treats the final millisecond of the bar as still inside it', () => {
    expect(applyQuote(bar(), quote(302, OPEN + 59_999), '1m').kind).toBe('update');
  });

  it('uses the asked-for timeframe, not a fixed period', () => {
    const at = OPEN + 30 * 60_000;
    expect(applyQuote(bar(), quote(302, at), '1m').kind).toBe('refetch');
    expect(applyQuote(bar(), quote(302, at), '1h').kind).toBe('update');
  });

  it('keeps a daily bar stamped at a session open alive all session', () => {
    // Daily US bars are stamped at NY midnight — 04:00 or 05:00 UTC — so flooring the
    // quote's time into a UTC day bucket disagrees with the bar's own `t` and would
    // report `refetch` on every single poll, refetching a whole day of history each time.
    const sessionMidnight = Date.UTC(2026, 7, 13, 4, 0, 0);
    const daily = makeBar({ t: sessionMidnight, o: 300, h: 301, l: 299, c: 300.5, v: 1 });
    if (daily === null) throw new Error('fixture rejected');
    // 15:59 New York, the same trading day.
    const duringSession = Date.UTC(2026, 7, 13, 19, 59, 0);
    expect(applyQuote(daily, quote(305, duringSession), '1d').kind).toBe('update');
  });
});

describe('a quote that cannot be used', () => {
  it('refuses one older than the bar on screen', () => {
    const result = applyQuote(bar(), quote(302, OPEN - 1), '1m');
    expect(result.kind).toBe('stale');
    if (result.kind !== 'stale') return;
    expect(result.reason).not.toBe('');
  });

  for (const [label, price] of [
    ['zero', 0],
    ['negative', -5],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`refuses a ${label} price`, () => {
      // A provider that answers a delisted ticker with 0 would otherwise redraw the bar
      // at zero and rescale the whole chart around it.
      expect(applyQuote(bar(), quote(price), '1m').kind).toBe('stale');
    });
  }

  it('refuses a quote with no usable time', () => {
    expect(applyQuote(bar(), quote(302, Number.NaN), '1m').kind).toBe('stale');
  });
});
