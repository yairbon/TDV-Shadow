import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * Twelve bars with high = close + 1 and low = close − 1, so every window's extremes are
 * read straight off the close list.
 *
 *   close  10  12  14  13  11  15  16  12  10  14  18  17
 *   high   11  13  15  14  12  16  17  13  11  15  19  18
 *   low     9  11  13  12  10  14  15  11   9  13  17  16
 *
 * tenkan 2, kijun 4, senkou B 6, displacement = kijun = 4.
 *
 *   tenkan   i1..i11:  11, 13, 13.5, 12, 13, 15.5, 14, 11, 12, 16, 17.5
 *   kijun    i3..i11:  12, 12.5, 13, 13.5, 13.5, 13, 13, 14, 14
 *   senkouA  raw i3..i7: 12.75, 12.25, 13, 14.5, 13.75  → drawn at i7..i11
 *   senkouB  raw i5..i7: 12.5, 13.5, 13.5              → drawn at i9..i11
 *   chikou   i0..i7:   close[i+4] = 11, 15, 16, 12, 10, 14, 18, 17
 */
const CLOSES = [10, 12, 14, 13, 11, 15, 16, 12, 10, 14, 18, 17];
const FIXTURE = bars(CLOSES.map((c) => [c, c + 1, c - 1, c, 100] as const));
const PARAMS = { tenkanPeriod: 2, kijunPeriod: 4, senkouBPeriod: 6 } as const;

const at = (values: Float64Array, from: number): number[] => Array.from(values.slice(from));

describe('Ichimoku Cloud', () => {
  it('matches hand-computed Tenkan and Kijun channel midpoints', () => {
    const { values } = computeIndicator('ichimoku', FIXTURE, PARAMS);
    expect(Number.isNaN(values['tenkan'][0])).toBe(true);
    expect(at(values['tenkan'], 1)).toEqual([11, 13, 13.5, 12, 13, 15.5, 14, 11, 12, 16, 17.5]);
    for (let i = 0; i < 3; i++) expect(Number.isNaN(values['kijun'][i])).toBe(true);
    expect(at(values['kijun'], 3)).toEqual([12, 12.5, 13, 13.5, 13.5, 13, 13, 14, 14]);
  });

  it('displaces both Senkou spans 26 (here 4) bars forward', () => {
    const { values } = computeIndicator('ichimoku', FIXTURE, PARAMS);
    for (let i = 0; i < 7; i++) expect(Number.isNaN(values['senkouA'][i])).toBe(true);
    expect(at(values['senkouA'], 7)).toEqual([12.75, 12.25, 13, 14.5, 13.75]);

    for (let i = 0; i < 9; i++) expect(Number.isNaN(values['senkouB'][i])).toBe(true);
    expect(at(values['senkouB'], 9)).toEqual([12.5, 13.5, 13.5]);
  });

  it('displaces Chikou backwards, leaving the TAIL NaN rather than the head', () => {
    const { values } = computeIndicator('ichimoku', FIXTURE, PARAMS);
    expect(at(values['chikou'], 0).slice(0, 8)).toEqual([11, 15, 16, 12, 10, 14, 18, 17]);
    for (let i = 8; i < CLOSES.length; i++) expect(Number.isNaN(values['chikou'][i])).toBe(true);
  });

  it('reports warm-up 0 because Chikou carries a value from bar 0', () => {
    const result = computeIndicator('ichimoku', FIXTURE, PARAMS);
    expect(result.plots[0].key).toBe('chikou');
    expect(result.warmup).toBe(0);
    expect(Number.isFinite(result.values['chikou'][0])).toBe(true);
  });

  it('forms each line at its own period with the default 9 / 26 / 52', () => {
    const input = wiggle(140);
    const { values } = computeIndicator('ichimoku', input);
    const firstReal = (key: string): number => {
      let i = 0;
      while (i < input.length && Number.isNaN(values[key][i])) i++;
      return i;
    };
    expect(firstReal('tenkan')).toBe(8); // 9 − 1
    expect(firstReal('kijun')).toBe(25); // 26 − 1
    expect(firstReal('senkouA')).toBe(51); // max(8, 25) + 26
    expect(firstReal('senkouB')).toBe(77); // 52 − 1 + 26
    expect(firstReal('chikou')).toBe(0);
    for (let i = input.length - 26; i < input.length; i++) {
      expect(Number.isNaN(values['chikou'][i])).toBe(true);
    }
  });

  it('keeps each line inside the high-low range of its own window', () => {
    const input = wiggle(140);
    const { values } = computeIndicator('ichimoku', input);
    for (let i = 25; i < input.length; i++) {
      let high = -Infinity;
      let low = Infinity;
      for (let j = i - 25; j <= i; j++) {
        high = Math.max(high, input[j].h);
        low = Math.min(low, input[j].l);
      }
      expect(values['kijun'][i]).toBeCloseTo((high + low) / 2, 12);
      expect(values['kijun'][i]).toBeLessThanOrEqual(high);
      expect(values['kijun'][i]).toBeGreaterThanOrEqual(low);
    }
  });

  it('declares five plots on the price plot and handles empty and single-bar input', () => {
    const result = computeIndicator('ichimoku', FIXTURE);
    expect(result.placement).toBe('overlay');
    expect(result.plots.map((p) => p.key).sort()).toEqual([
      'chikou',
      'kijun',
      'senkouA',
      'senkouB',
      'tenkan',
    ]);

    const empty = computeIndicator('ichimoku', []);
    for (const plot of empty.plots) expect(empty.values[plot.key].length).toBe(0);

    const single = computeIndicator('ichimoku', [bar(0, 10, 11, 9, 10.5)]);
    for (const plot of single.plots) {
      expect(single.values[plot.key].length).toBe(1);
      expect(Number.isNaN(single.values[plot.key][0])).toBe(true);
    }
  });
});
