import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * Each bar is built so the typical price (h + l + c) / 3 equals its close exactly
 * (h = c + 1.5, l = c − 1.5), which makes the window arithmetic hand-checkable.
 *
 * TP: 10 12 14 13 11 11 11 11
 * period 3:
 *   i=2  mean 12      MAD (2+0+2)/3 = 4/3      CCI (14−12)/(0.015·4/3)      =  100
 *   i=3  mean 13      MAD (1+1+0)/3 = 2/3      CCI (13−13)/…                =    0
 *   i=4  mean 38/3    MAD (4/3+1/3+5/3)/3=10/9 CCI (11−38/3)/(0.015·10/9)   = −100
 *   i=5  mean 35/3    MAD (4/3+2/3+2/3)/3=8/9  CCI (11−35/3)/(0.015·8/9)    =  −50
 *   i=6  mean 11      MAD 0                    flat window                  =    0
 */
const tp = (close: number, i: number): readonly [number, number, number, number, number] => [
  close,
  close + 1.5,
  close - 1.5,
  close,
  100 + i,
];

const FIXTURE = bars([10, 12, 14, 13, 11, 11, 11, 11].map(tp));

describe('CCI', () => {
  it('matches hand-computed values with the 0.015 mean-absolute-deviation scaling', () => {
    const { values } = computeIndicator('cci', FIXTURE, { period: 3, source: 'hlc3' });
    expect(values['cci'][2]).toBeCloseTo(100, 9);
    expect(values['cci'][3]).toBeCloseTo(0, 9);
    expect(values['cci'][4]).toBeCloseTo(-100, 9);
    expect(values['cci'][5]).toBeCloseTo(-50, 9);
  });

  it('is exactly 0 when price sits on its window mean', () => {
    const { values } = computeIndicator('cci', FIXTURE, { period: 3 });
    // i=3: TP 13 is the mean of 12, 14, 13.
    expect(values['cci'][3]).toBe(0);
    // i=6: the whole window is 11 — zero deviation AND zero numerator.
    expect(values['cci'][6]).toBe(0);
    expect(Number.isNaN(values['cci'][6])).toBe(false);
  });

  it('warms up for exactly period − 1 bars', () => {
    const input = wiggle(40);
    for (const period of [3, 20]) {
      const result = computeIndicator('cci', input, { period });
      expect(result.warmup).toBe(period - 1);
      for (let i = 0; i < period - 1; i++) expect(Number.isNaN(result.values['cci'][i])).toBe(true);
      expect(Number.isFinite(result.values['cci'][period - 1])).toBe(true);
    }
  });

  it('uses the mean absolute deviation, not the standard deviation', () => {
    // Window 10, 12, 14 has MAD 4/3 but population sigma sqrt(8/3) ≈ 1.633. Reading 100
    // here can only come from the MAD; sigma would give ≈ 81.6.
    const { values } = computeIndicator('cci', FIXTURE, { period: 3 });
    expect(values['cci'][2]).toBeCloseTo(100, 9);
    expect(values['cci'][2]).not.toBeCloseTo((14 - 12) / (0.015 * Math.sqrt(8 / 3)), 3);
  });

  it('defaults to period 20 on the typical price', () => {
    const input = wiggle(40);
    const byDefault = computeIndicator('cci', input);
    const explicit = computeIndicator('cci', input, { period: 20, source: 'hlc3' });
    expect(byDefault.warmup).toBe(19);
    for (let i = 19; i < input.length; i++) {
      expect(byDefault.values['cci'][i]).toBeCloseTo(explicit.values['cci'][i], 12);
    }
  });

  it('handles empty and single-bar input', () => {
    expect(computeIndicator('cci', []).values['cci'].length).toBe(0);
    const single = computeIndicator('cci', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['cci'].length).toBe(1);
    expect(Number.isNaN(single.values['cci'][0])).toBe(true);
  });
});
