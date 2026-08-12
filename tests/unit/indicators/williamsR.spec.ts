import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * o    h    l    c
 * 10   12    8   10
 * 13   14    9   13
 * 12   15   11   12
 * 11   13   10   11
 * 16   16   12   16
 * 14   16   14   14
 *
 * period 3:
 *   i=2  HH 15  LL  8  c 12  →  −100·(15−12)/7 = −300/7 ≈ −42.857142857
 *   i=3  HH 15  LL  9  c 11  →  −100·(15−11)/6 = −200/3 ≈ −66.666666667
 *   i=4  HH 16  LL 10  c 16  →  −100·0/6       =   0     (close at the window high)
 *   i=5  HH 16  LL 10  c 14  →  −100·2/6       = −100/3 ≈ −33.333333333
 */
const FIXTURE = bars([
  [10, 12, 8, 10, 100],
  [13, 14, 9, 13, 100],
  [12, 15, 11, 12, 100],
  [11, 13, 10, 11, 100],
  [16, 16, 12, 16, 100],
  [14, 16, 14, 14, 100],
]);

describe('Williams %R', () => {
  it('matches hand-computed values', () => {
    const { values } = computeIndicator('williams-r', FIXTURE, { period: 3 });
    expect(values['r'][2]).toBeCloseTo(-300 / 7, 9);
    expect(values['r'][3]).toBeCloseTo(-200 / 3, 9);
    expect(values['r'][4]).toBeCloseTo(0, 12);
    expect(values['r'][5]).toBeCloseTo(-100 / 3, 9);
  });

  it('warms up for exactly period − 1 bars', () => {
    const input = wiggle(40);
    for (const period of [3, 14]) {
      const result = computeIndicator('williams-r', input, { period });
      expect(result.warmup).toBe(period - 1);
      for (let i = 0; i < period - 1; i++) expect(Number.isNaN(result.values['r'][i])).toBe(true);
      expect(Number.isFinite(result.values['r'][period - 1])).toBe(true);
    }
  });

  it('stays inside [−100, 0] and reports those bounds', () => {
    const result = computeIndicator('williams-r', wiggle(120), { period: 14 });
    let seen = 0;
    for (const v of result.values['r']) {
      if (Number.isNaN(v)) continue;
      seen++;
      expect(v).toBeGreaterThanOrEqual(-100);
      expect(v).toBeLessThanOrEqual(0);
    }
    expect(seen).toBe(120 - 13);
    expect(result.scaleBounds).toEqual([-100, 0]);
    expect(result.guides).toEqual([-20, -80]);
  });

  it('reads 0 at the window high and −100 at the window low', () => {
    // Rising series: every close is the highest high so far → 0 throughout.
    const up = bars(
      Array.from({ length: 10 }, (_, i) => [i + 1, i + 1.5, i + 0.5, i + 1, 100] as const),
    );
    const { values } = computeIndicator('williams-r', up, { period: 3 });
    // The window high is the CURRENT bar's high (close + 0.5), so %R is −100·0.5/span.
    expect(values['r'][9]).toBeGreaterThan(-100);
    expect(values['r'][9]).toBeLessThan(0);

    // A bar closing at its window low reads exactly −100.
    const drop = bars([
      [10, 11, 9, 10, 100],
      [10, 11, 9, 10, 100],
      [10, 11, 5, 5, 100],
    ]);
    expect(computeIndicator('williams-r', drop, { period: 3 }).values['r'][2]).toBeCloseTo(-100, 12);
  });

  it('reads −50 on a flat window instead of dividing by zero', () => {
    const flat = bars(Array.from({ length: 5 }, () => [50, 50, 50, 50, 10] as const));
    const { values } = computeIndicator('williams-r', flat, { period: 3 });
    expect(values['r'][4]).toBe(-50);
  });

  it('handles empty and single-bar input', () => {
    expect(computeIndicator('williams-r', []).values['r'].length).toBe(0);
    const single = computeIndicator('williams-r', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['r'].length).toBe(1);
    expect(Number.isNaN(single.values['r'][0])).toBe(true);
  });
});
