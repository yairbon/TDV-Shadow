import { describe, expect, it } from 'vitest';

import { makeBar, type Bar } from '../../../src/data/types.js';
import { computeIndicator, INDICATOR_IDS } from '../../../src/indicators/registry.js';
import { computeVolumeProfile } from '../../../src/indicators/volume.js';

const START = 1_754_870_400_000;
const STEP = 60_000;

function bar(i: number, o: number, h: number, l: number, c: number, v = 100): Bar {
  const made = makeBar({ t: START + i * STEP, o, h, l, c, v });
  if (made === null) throw new Error(`invalid fixture bar ${String(i)}`);
  return made;
}

/** Closes 1..n, so hand-computing an average is trivial. */
function ramp(n: number): Bar[] {
  return Array.from({ length: n }, (_, i) => bar(i, i + 1, i + 1.5, i + 0.5, i + 1));
}

function wiggle(n: number): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const drift = Math.sin(i / 3) * 2;
    const close = price + drift;
    out.push(bar(i, price, Math.max(price, close) + 1, Math.min(price, close) - 1, close, 50 + i));
    price = close;
  }
  return out;
}

const leadingNaN = (a: Float64Array): number => {
  let n = 0;
  while (n < a.length && Number.isNaN(a[n])) n++;
  return n;
};

describe('every indicator', () => {
  it.each(INDICATOR_IDS)('%s reports warmup equal to its leading-NaN count', (id) => {
    const result = computeIndicator(id, wiggle(80));
    const first = result.plots[0];
    const values = result.values[first.key];
    expect(result.warmup).toBe(leadingNaN(values));
  });

  it.each(INDICATOR_IDS)('%s pads warm-up with NaN, never 0', (id) => {
    const result = computeIndicator(id, wiggle(60));
    for (const plot of result.plots) {
      const values = result.values[plot.key];
      // Every value before warm-up must be NaN — a 0 here would draw a cliff.
      for (let i = 0; i < result.warmup; i++) expect(Number.isNaN(values[i])).toBe(true);
    }
  });

  it.each(INDICATOR_IDS)('%s returns all-NaN for empty input rather than throwing', (id) => {
    const result = computeIndicator(id, []);
    for (const plot of result.plots) expect(result.values[plot.key].length).toBe(0);
  });

  it.each(INDICATOR_IDS)('%s survives a single bar', (id) => {
    expect(() => computeIndicator(id, [bar(0, 10, 11, 9, 10.5)])).not.toThrow();
  });

  it.each(INDICATOR_IDS)('%s allocates one array per plot aligned to the bars', (id) => {
    const bars = wiggle(40);
    const result = computeIndicator(id, bars);
    for (const plot of result.plots) {
      expect(result.values[plot.key]).toBeInstanceOf(Float64Array);
      expect(result.values[plot.key].length).toBe(bars.length);
    }
  });
});

describe('SMA', () => {
  it('matches a hand-computed mean', () => {
    // closes 1..5, period 3 -> first value at index 2 = (1+2+3)/3 = 2
    const { values, warmup } = computeIndicator('sma', ramp(5), { period: 3 });
    expect(warmup).toBe(2);
    expect(values['sma'][2]).toBeCloseTo(2, 12);
    expect(values['sma'][3]).toBeCloseTo(3, 12);
    expect(values['sma'][4]).toBeCloseTo(4, 12);
  });
});

describe('EMA', () => {
  it('seeds from the SMA then applies k = 2/(period+1)', () => {
    // closes 1..5, period 3: seed at index 2 = 2; k = 0.5
    // index 3 = (4 - 2) * 0.5 + 2 = 3 ; index 4 = (5 - 3) * 0.5 + 3 = 4
    const { values } = computeIndicator('ema', ramp(5), { period: 3 });
    expect(values['ema'][2]).toBeCloseTo(2, 12);
    expect(values['ema'][3]).toBeCloseTo(3, 12);
    expect(values['ema'][4]).toBeCloseTo(4, 12);
  });
});

describe('RSI', () => {
  it('is 100 on a monotonically rising series (no losses)', () => {
    const { values } = computeIndicator('rsi', ramp(30), { period: 14 });
    expect(values['rsi'][29]).toBeCloseTo(100, 9);
  });

  it('stays within [0, 100] on noisy data', () => {
    const { values } = computeIndicator('rsi', wiggle(120), { period: 14 });
    for (const v of values['rsi']) {
      if (Number.isNaN(v)) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it('declares fixed 0..100 bounds and the 30/70 guides', () => {
    const result = computeIndicator('rsi', wiggle(60));
    expect(result.scaleBounds).toEqual([0, 100]);
    expect(result.guides).toEqual([30, 70]);
  });
});

describe('MACD', () => {
  it('macd line equals fastEMA - slowEMA, and histogram equals macd - signal', () => {
    const bars = wiggle(120);
    const { values } = computeIndicator('macd', bars, {
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
    });
    const fast = computeIndicator('ema', bars, { period: 12 }).values['ema'];
    const slow = computeIndicator('ema', bars, { period: 26 }).values['ema'];

    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(fast[i]) || Number.isNaN(slow[i])) continue;
      expect(values['macd'][i]).toBeCloseTo(fast[i] - slow[i], 10);
    }
    for (let i = 0; i < bars.length; i++) {
      if (Number.isNaN(values['signal'][i])) continue;
      expect(values['histogram'][i]).toBeCloseTo(values['macd'][i] - values['signal'][i], 10);
    }
  });

  it('does not let leading NaNs poison the signal seed', () => {
    const { values, warmup } = computeIndicator('macd', wiggle(120));
    const signalStart = leadingNaN(values['signal']);
    expect(signalStart).toBeGreaterThan(warmup);
    expect(Number.isFinite(values['signal'][signalStart])).toBe(true);
  });
});

describe('Bollinger Bands', () => {
  it('is symmetric about the basis', () => {
    const { values } = computeIndicator('bollinger', wiggle(80), { period: 20, stdDev: 2 });
    for (let i = 0; i < 80; i++) {
      if (Number.isNaN(values['middle'][i])) continue;
      const up = values['upper'][i] - values['middle'][i];
      const down = values['middle'][i] - values['lower'][i];
      expect(up).toBeCloseTo(down, 10);
    }
  });

  it('collapses to the basis when the window is flat', () => {
    const flat = Array.from({ length: 30 }, (_, i) => bar(i, 50, 50, 50, 50));
    const { values } = computeIndicator('bollinger', flat, { period: 20 });
    expect(values['upper'][25]).toBeCloseTo(50, 10);
    expect(values['lower'][25]).toBeCloseTo(50, 10);
  });
});

describe('Volume Profile', () => {
  const bars = wiggle(100);

  it('conserves volume — buckets sum to the total traded volume', () => {
    const profile = computeVolumeProfile(bars, { buckets: 24 });
    const bucketTotal = profile.buckets.reduce((sum, b) => sum + b.volume, 0);
    const traded = bars.reduce((sum, b) => sum + b.v, 0);
    expect(bucketTotal).toBeCloseTo(traded, 6);
  });

  it('puts the point of control at the highest-volume bucket', () => {
    const profile = computeVolumeProfile(bars, { buckets: 24 });
    const richest = profile.buckets.reduce((best, b) => (b.volume > best.volume ? b : best));
    expect(profile.pointOfControl).toBeCloseTo(richest.price, 9);
  });

  it('value area encloses at least the requested share of volume', () => {
    const profile = computeVolumeProfile(bars, { buckets: 24, valueAreaPercent: 70 });
    const traded = bars.reduce((sum, b) => sum + b.v, 0);
    const inside = profile.buckets
      .filter((b) => b.price >= profile.valueAreaLow && b.price <= profile.valueAreaHigh)
      .reduce((sum, b) => sum + b.volume, 0);
    expect(inside).toBeGreaterThanOrEqual(traded * 0.7 - 1e-6);
    expect(profile.valueAreaHigh).toBeGreaterThan(profile.valueAreaLow);
  });

  it('handles a perfectly flat series without dividing by a zero-width bucket', () => {
    const flat = Array.from({ length: 10 }, (_, i) => bar(i, 50, 50, 50, 50, 5));
    const profile = computeVolumeProfile(flat, { buckets: 8 });
    expect(Number.isFinite(profile.pointOfControl)).toBe(true);
    const total = profile.buckets.reduce((sum, b) => sum + b.volume, 0);
    expect(total).toBeCloseTo(50, 6);
  });
});

describe('ATR', () => {
  it('equals the mean true range on a series with constant range', () => {
    // Every bar spans exactly 2 and closes at its midpoint, so TR is 2 throughout.
    const bars = Array.from({ length: 40 }, (_, i) => bar(i, 100, 101, 99, 100));
    const { values } = computeIndicator('atr', bars, { period: 14 });
    expect(values['atr'][39]).toBeCloseTo(2, 9);
  });
});
