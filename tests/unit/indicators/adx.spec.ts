import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, falling, rising, wiggle } from './fixtures.js';

/**
 * Hand-worked with period 2.
 *
 *  i   o     h    l     c      +DM  −DM   TR
 *  0   9    10    8    9        –    –     –
 *  1  11    12    9   11        2    0     3      (up 2, down −1)
 *  2  12    13   11   12        1    0     2      (up 1, down −2)
 *  3  10.5  12   10   10.5      0    1     2      (up −1, down 1)
 *  4   9.5  11    9    9.5      0    1     2      (up −1, down 1)
 *  5  13    14   10   13        3    0     4.5    (up 3, down −1; TR from |14 − 9.5|)
 *
 * Wilder(2) from index 1, seeded with the mean of i=1,2:
 *   TR   2.5    2.25     2.125    3.3125
 *   +DM  1.5    0.75     0.375    1.6875
 *   −DM  0      0.5      0.75     0.375
 *
 *   +DI  60     33.3333  17.6471  50.9434
 *   −DI   0     22.2222  35.2941  11.3208
 *   DX  100     20       33.3333  63.6364
 *   ADX   –     60       46.6667  55.1515   (Wilder(2) of DX, seeded at index 3)
 */
const FIXTURE = bars([
  [9, 10, 8, 9, 100],
  [11, 12, 9, 11, 100],
  [12, 13, 11, 12, 100],
  [10.5, 12, 10, 10.5, 100],
  [9.5, 11, 9, 9.5, 100],
  [13, 14, 10, 13, 100],
]);

describe('ADX', () => {
  it('matches hand-computed +DI, −DI and ADX', () => {
    const { values } = computeIndicator('adx', FIXTURE, { period: 2 });
    expect(values['plusDI'][2]).toBeCloseTo(60, 9);
    expect(values['plusDI'][3]).toBeCloseTo((100 * 0.75) / 2.25, 9);
    expect(values['plusDI'][4]).toBeCloseTo((100 * 0.375) / 2.125, 9);
    expect(values['plusDI'][5]).toBeCloseTo((100 * 1.6875) / 3.3125, 9);

    expect(values['minusDI'][2]).toBeCloseTo(0, 12);
    expect(values['minusDI'][3]).toBeCloseTo((100 * 0.5) / 2.25, 9);
    expect(values['minusDI'][4]).toBeCloseTo((100 * 0.75) / 2.125, 9);
    expect(values['minusDI'][5]).toBeCloseTo((100 * 0.375) / 3.3125, 9);

    expect(values['adx'][3]).toBeCloseTo(60, 9);
    expect(values['adx'][4]).toBeCloseTo(46.666666667, 8);
    expect(values['adx'][5]).toBeCloseTo(55.151515152, 8);
  });

  it('forms the DI pair at index period and ADX at 2·period − 1', () => {
    const input = wiggle(80);
    for (const period of [2, 14]) {
      const { values, warmup } = computeIndicator('adx', input, { period });
      expect(warmup).toBe(period);
      for (let i = 0; i < period; i++) {
        expect(Number.isNaN(values['plusDI'][i])).toBe(true);
        expect(Number.isNaN(values['minusDI'][i])).toBe(true);
      }
      expect(Number.isFinite(values['plusDI'][period])).toBe(true);

      for (let i = 0; i < 2 * period - 1; i++) expect(Number.isNaN(values['adx'][i])).toBe(true);
      expect(Number.isFinite(values['adx'][2 * period - 1])).toBe(true);
    }
  });

  it('keeps all three plots inside [0, 100]', () => {
    const result = computeIndicator('adx', wiggle(200), { period: 14 });
    for (const key of ['plusDI', 'minusDI', 'adx']) {
      let seen = 0;
      for (const v of result.values[key]) {
        if (Number.isNaN(v)) continue;
        seen++;
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
      expect(seen).toBeGreaterThan(0);
    }
    expect(result.scaleBounds).toEqual([0, 100]);
  });

  it('puts +DI above −DI in a pure uptrend and below it in a pure downtrend', () => {
    const up = computeIndicator('adx', rising(60), { period: 14 });
    expect(up.values['plusDI'][59]).toBeGreaterThan(up.values['minusDI'][59]);
    expect(up.values['minusDI'][59]).toBe(0);
    // Every bar makes a new high and no new low, so DX pins at 100 and ADX follows.
    expect(up.values['adx'][59]).toBeCloseTo(100, 6);

    const down = computeIndicator('adx', falling(60), { period: 14 });
    expect(down.values['minusDI'][59]).toBeGreaterThan(down.values['plusDI'][59]);
    expect(down.values['plusDI'][59]).toBe(0);
    expect(down.values['adx'][59]).toBeCloseTo(100, 6);
  });

  it('awards nothing to either side when a symmetric outside bar ties the moves', () => {
    // Bar 2 expands by exactly 1 in both directions: upMove = downMove = 1. Wilder's rule
    // is strict on both tests, so NEITHER +DM nor −DM gets it and both DIs stay 0.
    // Awarding the tie to +DM would read 100·0.5/2 = 25 here.
    const tie = bars([
      [9.5, 10, 9, 9.5, 100],
      [9.5, 10, 9, 9.5, 100],
      [9.5, 11, 8, 9.5, 100],
    ]);
    const { values } = computeIndicator('adx', tie, { period: 2 });
    expect(values['plusDI'][2]).toBe(0);
    expect(values['minusDI'][2]).toBe(0);
  });

  it('awards nothing to either side when the moves tie', () => {
    // Every bar is an exact copy: upMove and downMove are both 0, so both DMs are 0 and
    // there is no directional reading at all.
    const flat = bars(Array.from({ length: 40 }, () => [10, 11, 9, 10, 100] as const));
    const { values } = computeIndicator('adx', flat, { period: 14 });
    expect(values['plusDI'][39]).toBe(0);
    expect(values['minusDI'][39]).toBe(0);
    expect(values['adx'][39]).toBe(0);
  });

  it('handles empty and single-bar input', () => {
    const empty = computeIndicator('adx', []);
    for (const plot of empty.plots) expect(empty.values[plot.key].length).toBe(0);
    const single = computeIndicator('adx', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['plusDI'].length).toBe(1);
    expect(Number.isNaN(single.values['plusDI'][0])).toBe(true);
  });
});
