/**
 * Aligning a second instrument onto the primary's index space.
 *
 * The obvious implementation — zip the two bar arrays by index — is wrong, and wrong in a
 * way that looks right: one extra holiday in the secondary shifts every later value by a
 * bar, and the overlay reads as a plausible curve that is a day out and drifting. So most
 * of these tests are about calendars that do not match.
 */

import { describe, expect, it } from 'vitest';
import { alignByTime, rebase } from '../../../src/charts/compare.js';
import { makeBar, type Bar } from '../../../src/data/types.js';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5);

/**
 * Bars on the given day offsets, closing at the given prices.
 *
 * `makeBar` validates and returns null; a null here is a broken fixture, not a case under
 * test, so it throws rather than quietly producing a shorter array that would make an
 * assertion pass for the wrong reason.
 */
function bars(days: readonly number[], closes: readonly number[]): Bar[] {
  return days.map((d, i) => {
    const price = closes[i];
    const bar = makeBar({ t: T0 + d * DAY, o: price, h: price, l: price, c: price, v: 1 });
    if (bar === null) throw new Error(`bad fixture bar at day ${String(d)}`);
    return bar;
  });
}

const seq = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

describe('alignByTime', () => {
  it('lines values up by time, not by index, when the secondary skips a day', () => {
    // The primary trades every day; the secondary is closed on day 2. Zipping by index
    // would put the secondary's day-3 close on the primary's day 2 and stay wrong after.
    const primary = bars([0, 1, 2, 3], [10, 11, 12, 13]);
    const secondary = bars([0, 1, 3], [100, 200, 400]);

    const aligned = alignByTime(primary, secondary);
    // Day 2 holds day 1's close — forward-filled, not day 3's pulled backwards.
    expect([...aligned.values]).toEqual([100, 200, 200, 400]);
  });

  it('forward-fills rather than interpolating', () => {
    // The midpoint of 100 and 400 is 250. A price of 250 never traded, so it must not be
    // drawn; the honest value on a day with no trade is the last one that did.
    const primary = bars([0, 1, 2], [1, 1, 1]);
    const secondary = bars([0, 2], [100, 400]);

    expect([...alignByTime(primary, secondary).values]).toEqual([100, 100, 400]);
  });

  it('has no value before the secondary’s first bar', () => {
    // Back-filling the first close would paint a flat 0% line across years the instrument
    // did not exist.
    const primary = bars([0, 1, 2, 3], [1, 1, 1, 1]);
    const secondary = bars([2, 3], [100, 110]);

    const aligned = alignByTime(primary, secondary);
    expect(Number.isNaN(aligned.values[0])).toBe(true);
    expect(Number.isNaN(aligned.values[1])).toBe(true);
    expect(aligned.from).toBe(2);
    expect(aligned.to).toBe(3);
  });

  it('has no value after the secondary’s last bar', () => {
    // Carrying a delisted instrument's final close to the right edge draws a flat line
    // that looks like a live quote.
    const primary = bars([0, 1, 2, 3], [1, 1, 1, 1]);
    const secondary = bars([0, 1], [100, 110]);

    const aligned = alignByTime(primary, secondary);
    expect([...aligned.values.slice(0, 2)]).toEqual([100, 110]);
    expect(Number.isNaN(aligned.values[2])).toBe(true);
    expect(Number.isNaN(aligned.values[3])).toBe(true);
    expect(aligned.to).toBe(1);
  });

  it('reports an empty overlap rather than guessing', () => {
    const primary = bars([0, 1], [1, 1]);
    const secondary = bars([50, 51], [100, 110]);

    const aligned = alignByTime(primary, secondary);
    expect(aligned.from).toBe(-1);
    expect(aligned.to).toBe(-1);
    expect([...aligned.percent].every(Number.isNaN)).toBe(true);
  });

  it('handles empty inputs on either side', () => {
    expect(alignByTime([], bars([0], [1])).from).toBe(-1);
    expect(alignByTime(bars([0], [1]), []).from).toBe(-1);
    expect(alignByTime([], []).values).toHaveLength(0);
  });

  it('never mutates either input', () => {
    const primary = bars([0, 1], [10, 11]);
    const secondary = bars([0, 1], [100, 110]);
    const before = JSON.stringify([primary, secondary]);
    alignByTime(primary, secondary);
    expect(JSON.stringify([primary, secondary])).toBe(before);
  });

  it('walks both arrays once rather than searching per bar', () => {
    // A quadratic implementation is still correct, so correctness tests cannot catch it —
    // and it is the difference between a frame and a freeze at 100k bars. Timing is the
    // only observable, so this asserts a generous ceiling rather than a tight one.
    const n = 60_000;
    const primary = bars(seq(n), seq(n).map(() => 1));
    const secondary = bars(seq(n), seq(n).map((i) => 100 + i));

    const started = performance.now();
    const aligned = alignByTime(primary, secondary);
    const elapsed = performance.now() - started;

    expect(aligned.to).toBe(n - 1);
    expect(elapsed).toBeLessThan(250);
  });
});

describe('percent and rebasing', () => {
  it('is zero at the base and reads as a percent change elsewhere', () => {
    const primary = bars([0, 1, 2], [1, 1, 1]);
    const secondary = bars([0, 1, 2], [100, 110, 90]);

    const aligned = alignByTime(primary, secondary);
    expect(aligned.base).toBe(100);
    expect(aligned.percent[0]).toBeCloseTo(0, 9);
    expect(aligned.percent[1]).toBeCloseTo(10, 9);
    expect(aligned.percent[2]).toBeCloseTo(-10, 9);
  });

  it('compared against itself, reproduces the instrument’s own percent change', () => {
    // The identity case. Not "flat at zero" — that would only be true of a flat price —
    // but exactly the primary's own move from the base, which is the definition the
    // overlay has to satisfy for the comparison to mean anything.
    const closes = [100, 130, 90, 175];
    const primary = bars([0, 1, 2, 3], closes);

    const aligned = alignByTime(primary, primary);
    expect(aligned.base).toBe(closes[0]);
    for (let i = 0; i < closes.length; i++) {
      expect(aligned.percent[i]).toBeCloseTo((closes[i] / closes[0] - 1) * 100, 9);
    }
  });

  it('moves the whole curve when rebased, without changing its shape', () => {
    const primary = bars([0, 1, 2, 3], [1, 1, 1, 1]);
    const secondary = bars([0, 1, 2, 3], [100, 110, 121, 133.1]);

    const atZero = alignByTime(primary, secondary);
    const atTwo = rebase(atZero, 2);
    expect(atTwo.base).toBe(121);
    expect(atTwo.percent[2]).toBeCloseTo(0, 9);

    // Shape is the sequence of ratios between consecutive points; rebasing must not touch
    // it. Comparing the percent values themselves would only prove they moved.
    const shape = (p: Float64Array): number[] =>
      [0, 1, 2].map((i) => (1 + p[i + 1] / 100) / (1 + p[i] / 100));
    const a = shape(atZero.percent);
    const b = shape(atTwo.percent);
    for (let i = 0; i < a.length; i++) expect(b[i]).toBeCloseTo(a[i], 9);
  });

  it('falls forward to the next real value when the base index has none', () => {
    // The view's left edge routinely lands on the secondary's leading NaNs.
    const primary = bars([0, 1, 2, 3], [1, 1, 1, 1]);
    const secondary = bars([2, 3], [100, 150]);

    const aligned = rebase(alignByTime(primary, secondary), 0);
    expect(aligned.base).toBe(100);
    expect(aligned.percent[3]).toBeCloseTo(50, 9);
  });

  it('falls back to the left when nothing lies at or after the base index', () => {
    // Scrolling past a delisted instrument should still show its history, not blank out.
    const primary = bars([0, 1, 2, 3], [1, 1, 1, 1]);
    const secondary = bars([0, 1], [100, 150]);

    const aligned = rebase(alignByTime(primary, secondary), 3);
    expect(aligned.base).toBe(150);
    expect(aligned.percent[0]).toBeCloseTo(-100 / 3, 6);
  });

  it('produces no percent at all when the base is not positive', () => {
    // Dividing by zero or a negative base yields an infinity or a sign flip, and either
    // draws a line that means nothing.
    const primary = bars([0, 1], [1, 1]);
    const secondary = bars([0, 1], [0, 50]);

    const aligned = alignByTime(primary, secondary);
    expect(aligned.base).toBe(0);
    expect([...aligned.percent].every(Number.isNaN)).toBe(true);
  });

  it('clamps a base index outside the array instead of throwing', () => {
    const primary = bars([0, 1], [1, 1]);
    const secondary = bars([0, 1], [100, 110]);
    const aligned = alignByTime(primary, secondary);

    expect(rebase(aligned, -50).base).toBe(100);
    expect(rebase(aligned, 999).base).toBe(110);
    expect(rebase(aligned, Number.NaN).base).toBe(100);
  });
});
