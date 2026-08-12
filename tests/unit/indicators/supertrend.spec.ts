import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * period 2, multiplier 1. The first five bars all have true range 4, so ATR(2) = 4 from
 * index 2; bar 5 crashes and its true range is 12, taking ATR to 4 + (12 − 4)/2 = 8.
 *
 *  i   o    h    l    c     TR   ATR  mid  basicUpper  basicLower
 *  0  10   11    9   10      –     –    –       –           –
 *  1  10   13    9   12      4     –    –       –           –
 *  2  12   15   11   14      4     4   13      17           9
 *  3  14   17   13   16      4     4   15      19          11
 *  4  16   19   15   18      4     4   17      21          13
 *  5  18   18    6    7     12     8   12      20           4
 *
 *  i=2  first formed bar → starts short: upper 17, lower 9, line = 17
 *  i=3  upper held at 17 (19 is not lower, and close[2]=14 did not clear it);
 *       lower ratchets 9 → 11; close 16 < 17 so still short → line = 17
 *  i=4  upper still 17; lower ratchets to 13; close 18 > 17 → FLIP long → line = 13
 *  i=5  close[4]=18 broke the old upper, so upper is released to 20;
 *       lower held at 13; close 7 < 13 → FLIP short → line = 20
 */
const FIXTURE = bars([
  [10, 11, 9, 10, 100],
  [10, 13, 9, 12, 100],
  [12, 15, 11, 14, 100],
  [14, 17, 13, 16, 100],
  [16, 19, 15, 18, 100],
  [18, 18, 6, 7, 100],
]);

const PARAMS = { period: 2, multiplier: 1 } as const;

describe('Supertrend', () => {
  it('matches a hand-computed ratchet with two flips', () => {
    const { values } = computeIndicator('supertrend', FIXTURE, PARAMS);
    expect(Array.from(values['supertrend'].slice(2))).toEqual([17, 17, 13, 20]);
  });

  it('flips to the other side of price when price crosses it', () => {
    const { values } = computeIndicator('supertrend', FIXTURE, PARAMS);
    // Short while the line is above the close…
    expect(values['supertrend'][3]).toBeGreaterThan(FIXTURE[3].c);
    // …long the bar the close clears it…
    expect(values['supertrend'][4]).toBeLessThan(FIXTURE[4].c);
    // …and short again on the crash.
    expect(values['supertrend'][5]).toBeGreaterThan(FIXTURE[5].c);
  });

  it('holds the band until price breaks it — the ratchet never loosens mid-trend', () => {
    const { values } = computeIndicator('supertrend', FIXTURE, PARAMS);
    // basicUpper rose 17 → 19 → 21 across bars 2–4 while the line stayed pinned at 17.
    expect(values['supertrend'][2]).toBe(17);
    expect(values['supertrend'][3]).toBe(17);
  });

  it('is never on the same side of price two flips in a row (each flip is a real cross)', () => {
    const input = wiggle(200);
    const { values } = computeIndicator('supertrend', input, { period: 10, multiplier: 3 });
    let previousSide = 0;
    let flips = 0;
    for (let i = 0; i < input.length; i++) {
      const value = values['supertrend'][i];
      if (Number.isNaN(value)) continue;
      const side = value < input[i].c ? 1 : -1;
      if (previousSide !== 0 && side !== previousSide) {
        flips++;
        // A flip means the close crossed the band it had been trailing.
        expect(side === 1 ? input[i].c > value : input[i].c < value).toBe(true);
      }
      previousSide = side;
    }
    expect(flips).toBeGreaterThan(0);
  });

  it('scales the distance from price with the multiplier', () => {
    const input = wiggle(120);
    const near = computeIndicator('supertrend', input, { period: 10, multiplier: 1 });
    const far = computeIndicator('supertrend', input, { period: 10, multiplier: 5 });
    const gap = (values: Float64Array, i: number): number => Math.abs(values[i] - input[i].c);
    let compared = 0;
    for (let i = 20; i < input.length; i++) {
      // Only compare where both agree on the trend side; a flip is a discontinuity.
      const nearSide = Math.sign(near.values['supertrend'][i] - input[i].c);
      const farSide = Math.sign(far.values['supertrend'][i] - input[i].c);
      if (nearSide !== farSide) continue;
      compared++;
      expect(gap(far.values['supertrend'], i)).toBeGreaterThan(gap(near.values['supertrend'], i));
    }
    expect(compared).toBeGreaterThan(20);
  });

  it('warms up exactly with its ATR', () => {
    const input = wiggle(60);
    for (const period of [2, 10]) {
      const result = computeIndicator('supertrend', input, { period, multiplier: 3 });
      // Wilder's ATR is seeded from the first true range at index 1, so it forms at
      // index `period`.
      expect(result.warmup).toBe(period);
      for (let i = 0; i < period; i++) {
        expect(Number.isNaN(result.values['supertrend'][i])).toBe(true);
      }
      expect(Number.isFinite(result.values['supertrend'][period])).toBe(true);
    }
  });

  it('draws on the price plot and handles empty and single-bar input', () => {
    expect(computeIndicator('supertrend', FIXTURE).placement).toBe('overlay');
    expect(computeIndicator('supertrend', []).values['supertrend'].length).toBe(0);
    const single = computeIndicator('supertrend', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['supertrend'].length).toBe(1);
    expect(Number.isNaN(single.values['supertrend'][0])).toBe(true);
  });
});
