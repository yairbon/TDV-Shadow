import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, falling, rising, wiggle } from './fixtures.js';

/**
 * step 0.02, max 0.2.
 *
 *  i   o     h    l     c
 *  0   9    10    8    9
 *  1  11    12    9   11
 *  2  12.5  13   10   12.5
 *  3  13.5  14   11   13.5
 *  4  12    13    7    7.5
 *  5   9    10    6    6.5
 *
 * Seed at i=1: close 11 > 9 → uptrend, SAR = min(l0, l1) = 8, EP = max(h0, h1) = 12,
 * AF = 0.02.
 *  i=2  8 + 0.02·(12 − 8) = 8.08, clamped by low[0] = 8 → 8; new high 13 → EP 13, AF 0.04
 *  i=3  8 + 0.04·(13 − 8) = 8.2, clamp does not bite; new high 14 → EP 14, AF 0.06
 *  i=4  8.2 + 0.06·(14 − 8.2) = 8.548; low 7 penetrates → REVERSE: SAR = EP = 14,
 *       EP = 7, AF = 0.02
 *  i=5  14 + 0.02·(7 − 14) = 13.86, clamped up by high[3] = 14 → 14
 */
const FIXTURE = bars([
  [9, 10, 8, 9, 100],
  [11, 12, 9, 11, 100],
  [12.5, 13, 10, 12.5, 100],
  [13.5, 14, 11, 13.5, 100],
  [12, 13, 7, 7.5, 100],
  [9, 10, 6, 6.5, 100],
]);

describe('Parabolic SAR', () => {
  it('matches a hand-computed acceleration and reversal', () => {
    const { values } = computeIndicator('psar', FIXTURE, { step: 0.02, maxStep: 0.2 });
    expect(Array.from(values['psar'].slice(1))).toEqual([8, 8, 8.2, 14, 14]);
  });

  it('warms up for exactly one bar — bar 0 has no direction to seed from', () => {
    const result = computeIndicator('psar', wiggle(60));
    expect(result.warmup).toBe(1);
    expect(Number.isNaN(result.values['psar'][0])).toBe(true);
    expect(Number.isFinite(result.values['psar'][1])).toBe(true);
  });

  it('sits below every bar of a pure uptrend and above every bar of a pure downtrend', () => {
    const up = computeIndicator('psar', rising(60));
    for (let i = 1; i < 60; i++) {
      expect(up.values['psar'][i]).toBeLessThan(rising(60)[i].l + 1e-9);
    }

    const downBars = falling(60);
    const down = computeIndicator('psar', downBars);
    for (let i = 1; i < 60; i++) {
      expect(down.values['psar'][i]).toBeGreaterThan(downBars[i].h - 1e-9);
    }
  });

  it('reverses to the old extreme point and never lands inside the previous two bars', () => {
    const input = wiggle(200);
    const { values } = computeIndicator('psar', input);
    let reversals = 0;
    for (let i = 2; i < input.length; i++) {
      const side = values['psar'][i] < input[i].l ? 1 : values['psar'][i] > input[i].h ? -1 : 0;
      const previousSide =
        values['psar'][i - 1] < input[i - 1].l ? 1 : values['psar'][i - 1] > input[i - 1].h ? -1 : 0;
      if (side !== 0 && previousSide !== 0 && side !== previousSide) reversals++;
      if (side === 1) {
        // An uptrend stop may never sit above either of the previous two bars' lows.
        expect(values['psar'][i]).toBeLessThanOrEqual(Math.min(input[i - 1].l, input[i - 2].l) + 1e-9);
      } else if (side === -1) {
        expect(values['psar'][i]).toBeGreaterThanOrEqual(
          Math.max(input[i - 1].h, input[i - 2].h) - 1e-9,
        );
      }
    }
    expect(reversals).toBeGreaterThan(3);
  });

  it('accelerates no further than maxStep', () => {
    const input = rising(200);
    // A slow acceleration keeps the stop further from price than a fast one on the same
    // uninterrupted trend, and a cap of exactly `step` never accelerates at all.
    const capped = computeIndicator('psar', input, { step: 0.02, maxStep: 0.02 });
    const uncapped = computeIndicator('psar', input, { step: 0.02, maxStep: 0.2 });
    const last = input.length - 1;
    expect(uncapped.values['psar'][last]).toBeGreaterThan(capped.values['psar'][last]);
    // With AF pinned at 0.02 the stop converges geometrically and stays well below price.
    expect(capped.values['psar'][last]).toBeLessThan(input[last].l);
  });

  it('draws dots on the price plot', () => {
    const result = computeIndicator('psar', FIXTURE);
    expect(result.placement).toBe('overlay');
    expect(result.plots[0].style).toBe('dots');
  });

  it('handles empty and single-bar input', () => {
    expect(computeIndicator('psar', []).values['psar'].length).toBe(0);
    const single = computeIndicator('psar', [bar(0, 10, 11, 9, 10.5)]);
    expect(single.values['psar'].length).toBe(1);
    expect(Number.isNaN(single.values['psar'][0])).toBe(true);
  });
});
