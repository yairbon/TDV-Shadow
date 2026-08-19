/**
 * The previous session's close.
 *
 * The failure that matters is a line drawn at a level that is not the previous close —
 * indistinguishable from a correct one at a glance, and read as support or resistance.
 * So the cases here are the ones where "previous" is ambiguous: the first session in view,
 * a daily series where every bar is its own session, and a data hole inside a session.
 */

import { describe, expect, it } from 'vitest';
import { previousSessionClose } from '../../../src/data/agg/previousClose.js';
import { makeBar, type Bar } from '../../../src/data/types.js';

/** A bar at `t` closing at `c`. */
function at(t: number, c: number): Bar {
  const bar = makeBar({ t, o: c, h: c + 1, l: c - 1, c, v: 10 });
  if (bar === null) throw new Error('fixture rejected');
  return bar;
}

const MIN = 60_000;
const DAY = 86_400_000;
/** 13:30 UTC — a US session open — on two consecutive days. */
const D1 = Date.UTC(2026, 7, 12, 13, 30);
const D2 = Date.UTC(2026, 7, 13, 13, 30);

describe('an intraday series', () => {
  it('takes the close of the last bar of the previous day', () => {
    const bars = [at(D1, 100), at(D1 + MIN, 101), at(D2, 200), at(D2 + MIN, 201)];
    expect(previousSessionClose(bars, '1m')).toBe(101);
  });

  it('is not confused by a gap inside the session', () => {
    // Yahoo drops untraded minutes, so holes inside a session are normal. A rule based on
    // "the first gap larger than the timeframe" would return the wrong bar here.
    const bars = [at(D1, 100), at(D1 + 30 * MIN, 105), at(D2, 200), at(D2 + 7 * MIN, 201)];
    expect(previousSessionClose(bars, '1m')).toBe(105);
  });

  it('reports nothing when the series never leaves one day', () => {
    // There is no previous session in view, and inventing one from the first bar would
    // draw a line the reader could not tell from a real level.
    const bars = [at(D2, 200), at(D2 + MIN, 201), at(D2 + 2 * MIN, 202)];
    expect(previousSessionClose(bars, '1m')).toBeNull();
  });

  it('skips a whole day that has no bars, as a weekend has none', () => {
    const friday = Date.UTC(2026, 7, 7, 13, 30);
    const bars = [at(friday, 90), at(friday + MIN, 91), at(D2, 200)];
    expect(previousSessionClose(bars, '1m')).toBe(91);
  });

  it('buckets by the display zone, not by UTC', () => {
    // 23:30 UTC is the same UTC day as 20:00 UTC, but in New York (-4h) they are 19:30 and
    // 16:00 — still one day. Shift far enough and the earlier bar becomes yesterday.
    const late = Date.UTC(2026, 7, 12, 23, 30);
    const next = Date.UTC(2026, 7, 13, 1, 0);
    const bars = [at(late, 100), at(next, 200)];
    // In UTC these are different days, so the earlier one is the previous session.
    expect(previousSessionClose(bars, '1h', 0)).toBe(100);
    // Shifted +2h both land on the 13th, so there is no previous session in view.
    expect(previousSessionClose(bars, '1h', 2 * 60 * 60_000)).toBeNull();
  });
});

describe('a daily series or coarser', () => {
  it('takes the bar before, because every bar is its own session', () => {
    // Bucketing by day here would compare the last bar to itself and find nothing.
    const bars = [at(D1 - DAY, 90), at(D1, 100), at(D2, 200)];
    expect(previousSessionClose(bars, '1d')).toBe(100);
  });
});

describe('refusing to guess', () => {
  it('reports nothing for a series with fewer than two bars', () => {
    expect(previousSessionClose([], '1m')).toBeNull();
    expect(previousSessionClose([at(D2, 200)], '1m')).toBeNull();
  });

  it('reports nothing for an offset that is not a number', () => {
    const bars = [at(D1, 100), at(D2, 200)];
    expect(previousSessionClose(bars, '1m', Number.NaN)).toBeNull();
  });
});
