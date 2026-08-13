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
 *   i=2  upper 15  lower  8  middle 11.5
 *   i=3  upper 15  lower  9  middle 12
 *   i=4  upper 16  lower 10  middle 13
 *   i=5  upper 16  lower 10  middle 13
 */
const FIXTURE = bars([
  [10, 12, 8, 10, 100],
  [13, 14, 9, 13, 100],
  [12, 15, 11, 12, 100],
  [11, 13, 10, 11, 100],
  [16, 16, 12, 16, 100],
  [14, 16, 14, 14, 100],
]);

describe('Donchian Channels', () => {
  it('matches hand-computed channel bounds', () => {
    const { values } = computeIndicator('donchian', FIXTURE, { period: 3 });
    expect(Array.from(values['upper'].slice(2))).toEqual([15, 15, 16, 16]);
    expect(Array.from(values['lower'].slice(2))).toEqual([8, 9, 10, 10]);
    expect(Array.from(values['middle'].slice(2))).toEqual([11.5, 12, 13, 13]);
  });

  it('warms up for exactly period − 1 bars on every plot', () => {
    const input = wiggle(60);
    for (const period of [3, 20]) {
      const result = computeIndicator('donchian', input, { period });
      expect(result.warmup).toBe(period - 1);
      for (const key of ['upper', 'middle', 'lower']) {
        for (let i = 0; i < period - 1; i++) {
          expect(Number.isNaN(result.values[key][i])).toBe(true);
        }
        expect(Number.isFinite(result.values[key][period - 1])).toBe(true);
      }
    }
  });

  it('upper is the rolling max of highs and lower the rolling min of lows', () => {
    const input = wiggle(80);
    const period = 20;
    const { values } = computeIndicator('donchian', input, { period });
    for (let i = period - 1; i < input.length; i++) {
      let high = -Infinity;
      let low = Infinity;
      for (let j = i - period + 1; j <= i; j++) {
        high = Math.max(high, input[j].h);
        low = Math.min(low, input[j].l);
      }
      expect(values['upper'][i]).toBeCloseTo(high, 12);
      expect(values['lower'][i]).toBeCloseTo(low, 12);
    }
  });

  it('orders lower ≤ middle ≤ upper and contains every bar in the window', () => {
    const input = wiggle(80);
    const { values } = computeIndicator('donchian', input, { period: 20 });
    for (let i = 19; i < input.length; i++) {
      expect(values['upper'][i]).toBeGreaterThanOrEqual(values['middle'][i]);
      expect(values['middle'][i]).toBeGreaterThanOrEqual(values['lower'][i]);
      // The window includes the current bar, so price can touch but never pierce.
      expect(input[i].h).toBeLessThanOrEqual(values['upper'][i] + 1e-9);
      expect(input[i].l).toBeGreaterThanOrEqual(values['lower'][i] - 1e-9);
      expect(values['middle'][i]).toBeCloseTo((values['upper'][i] + values['lower'][i]) / 2, 12);
    }
  });

  it('draws on the price plot', () => {
    expect(computeIndicator('donchian', FIXTURE).placement).toBe('overlay');
  });

  it('handles empty and single-bar input', () => {
    const empty = computeIndicator('donchian', []);
    for (const plot of empty.plots) expect(empty.values[plot.key].length).toBe(0);
    const single = computeIndicator('donchian', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['upper'].length).toBe(1);
    expect(Number.isNaN(single.values['upper'][0])).toBe(true);
  });
});
