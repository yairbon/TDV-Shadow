import { describe, expect, it } from 'vitest';

import { computeIndicator } from '../../../src/indicators/registry.js';
import { bar, bars, wiggle } from './fixtures.js';

/**
 * closes  10   11   11    9   12   12   13
 * volume 100  200  300  400  500  600  700
 * OBV      0 +200   =  -400 +500    =  +700
 *          0  200  200  -200  300  300  1000
 */
const FIXTURE = bars([
  [10, 10.5, 9.5, 10, 100],
  [10, 11.5, 9.5, 11, 200],
  [11, 11.5, 10.5, 11, 300],
  [11, 11.5, 8.5, 9, 400],
  [9, 12.5, 8.5, 12, 500],
  [12, 12.5, 11.5, 12, 600],
  [12, 13.5, 11.5, 13, 700],
]);

const EXPECTED = [0, 200, 200, -200, 300, 300, 1000];

describe('OBV', () => {
  it('matches a hand-computed running total', () => {
    const { values } = computeIndicator('obv', FIXTURE);
    for (let i = 0; i < EXPECTED.length; i++) {
      expect(values['obv'][i]).toBeCloseTo(EXPECTED[i], 9);
    }
  });

  it('is defined from the first bar — the accumulator starts at 0, not NaN', () => {
    const result = computeIndicator('obv', FIXTURE);
    expect(result.warmup).toBe(0);
    expect(result.values['obv'][0]).toBe(0);
  });

  it('leaves the total untouched when the close is unchanged', () => {
    const { values } = computeIndicator('obv', FIXTURE);
    // bar 2 closes at 11 exactly as bar 1 did, so its 300 volume is ignored.
    expect(values['obv'][2]).toBe(values['obv'][1]);
    // bar 5 repeats bar 4's close of 12.
    expect(values['obv'][5]).toBe(values['obv'][4]);
  });

  it('steps by exactly the bar volume, signed by the close change', () => {
    const input = wiggle(60);
    const { values } = computeIndicator('obv', input);
    for (let i = 1; i < input.length; i++) {
      const step = values['obv'][i] - values['obv'][i - 1];
      const direction = Math.sign(input[i].c - input[i - 1].c);
      expect(step).toBeCloseTo(direction * input[i].v, 6);
    }
  });

  it('renders in its own pane with a zero guide', () => {
    const result = computeIndicator('obv', FIXTURE);
    expect(result.placement).toBe('pane');
    expect(result.guides).toEqual([0]);
    expect(result.scaleBounds).toBeNull();
  });

  it('handles empty and single-bar input', () => {
    expect(computeIndicator('obv', []).values['obv'].length).toBe(0);
    const single = computeIndicator('obv', [bar(0, 10, 11, 9, 10.5, 42)]);
    expect(single.values['obv'].length).toBe(1);
    expect(single.values['obv'][0]).toBe(0);
  });
});
