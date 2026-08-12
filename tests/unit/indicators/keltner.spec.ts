import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * Closes rise by 2 and every bar spans exactly 4 with a 1-point overhang either side, so
 * the true range is 4 on every bar after the first:
 *
 *   o    h    l    c     TR
 *  10   11    9   10      –
 *  10   13    9   12      max(4, |13−10|, |9−10|) = 4
 *  12   15   11   14      4
 *  14   17   13   16      4
 *  16   19   15   18      4
 *
 * ATR(2) is therefore 4 from index 2 onwards.
 * EMA(close, 3): seed at index 2 = (10+12+14)/3 = 12, k = 0.5
 *   index 3 = (16 − 12)·0.5 + 12 = 14 ; index 4 = (18 − 14)·0.5 + 14 = 16
 * multiplier 2 → bands sit 8 away from the basis:
 *   index 2  middle 12  upper 20  lower  4
 *   index 3  middle 14  upper 22  lower  6
 *   index 4  middle 16  upper 24  lower  8
 */
const FIXTURE = bars([
  [10, 11, 9, 10, 100],
  [10, 13, 9, 12, 100],
  [12, 15, 11, 14, 100],
  [14, 17, 13, 16, 100],
  [16, 19, 15, 18, 100],
]);

const PARAMS = { period: 3, atrPeriod: 2, multiplier: 2 } as const;

describe('Keltner Channels', () => {
  it('matches a hand-computed EMA basis with ATR bands', () => {
    const { values } = computeIndicator('keltner', FIXTURE, PARAMS);
    expect(Array.from(values['middle'].slice(2))).toEqual([12, 14, 16]);
    expect(Array.from(values['upper'].slice(2))).toEqual([20, 22, 24]);
    expect(Array.from(values['lower'].slice(2))).toEqual([4, 6, 8]);
  });

  it('scales the band width by the multiplier, not the standard deviation', () => {
    const wide = computeIndicator('keltner', FIXTURE, { ...PARAMS, multiplier: 3 });
    expect(wide.values['upper'][4]).toBeCloseTo(16 + 3 * 4, 12);
    expect(wide.values['lower'][4]).toBeCloseTo(16 - 3 * 4, 12);
  });

  it('is symmetric about the basis and never inverted', () => {
    const input = wiggle(80);
    const { values } = computeIndicator('keltner', input);
    for (let i = 0; i < input.length; i++) {
      if (Number.isNaN(values['upper'][i])) continue;
      expect(values['upper'][i] - values['middle'][i]).toBeCloseTo(
        values['middle'][i] - values['lower'][i],
        10,
      );
      expect(values['upper'][i]).toBeGreaterThan(values['lower'][i]);
    }
  });

  it('warms up with the EMA basis and never emits a band before the ATR is formed', () => {
    const input = wiggle(80);
    const result = computeIndicator('keltner', input, { period: 20, atrPeriod: 10, multiplier: 2 });
    // EMA(20) forms at index 19; ATR(10) forms at index 10, so 19 governs both.
    expect(result.warmup).toBe(19);
    for (const key of ['middle', 'upper', 'lower']) {
      for (let i = 0; i < 19; i++) expect(Number.isNaN(result.values[key][i])).toBe(true);
      expect(Number.isFinite(result.values[key][19])).toBe(true);
    }
  });

  it('holds the bands back when the ATR is the slower of the two', () => {
    const input = wiggle(80);
    // EMA(5) forms at index 4 but ATR(30) not until index 30 — the bands must stay NaN
    // rather than collapsing onto the basis.
    const { values, warmup } = computeIndicator('keltner', input, {
      period: 5,
      atrPeriod: 30,
      multiplier: 2,
    });
    expect(warmup).toBe(4);
    for (let i = 4; i < 30; i++) {
      expect(Number.isFinite(values['middle'][i])).toBe(true);
      expect(Number.isNaN(values['upper'][i])).toBe(true);
      expect(Number.isNaN(values['lower'][i])).toBe(true);
    }
    expect(Number.isFinite(values['upper'][30])).toBe(true);
  });

  it('uses the ATR, not the raw bar range — a gap widens the channel', () => {
    // Same closes as FIXTURE but bar 4 gaps up: its true range is measured from the
    // previous close, so it exceeds the bar's own high−low.
    const gapped = bars([
      [10, 11, 9, 10, 100],
      [10, 13, 9, 12, 100],
      [12, 15, 11, 14, 100],
      [14, 17, 13, 16, 100],
      [26, 27, 25, 26, 100],
    ]);
    const { values } = computeIndicator('keltner', gapped, PARAMS);
    // TR at index 4 = max(2, |27−16|, |25−16|) = 11; ATR(2) = 4 + (11 − 4)/2 = 7.5
    // EMA(3) at index 4 = (26 − 14)·0.5 + 14 = 20 → bands 2 × 7.5 = 15 away
    expect(values['middle'][4]).toBeCloseTo(20, 12);
    expect(values['upper'][4]).toBeCloseTo(35, 12);
    expect(values['lower'][4]).toBeCloseTo(5, 12);
  });

  it('draws on the price plot and handles empty input', () => {
    expect(computeIndicator('keltner', FIXTURE).placement).toBe('overlay');
    const empty = computeIndicator('keltner', []);
    for (const plot of empty.plots) expect(empty.values[plot.key].length).toBe(0);
    const single = computeIndicator('keltner', [bar(0, 10, 11, 9, 10.5)]);
    expect(Number.isNaN(single.values['middle'][0])).toBe(true);
  });
});
