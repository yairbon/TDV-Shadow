/**
 * Indicator on indicator.
 *
 * The mechanism is a projection: one indicator's output becomes the price series the next
 * one reads. What has to hold is that the projection is faithful (same length, same bar
 * times, the value in every price field), that warm-up composes rather than being papered
 * over, and that a derived result is genuinely different from the same indicator over
 * price — the failure worth catching is a "derived" SMA that quietly averaged closes.
 */

import { describe, expect, it } from 'vitest';
import {
  deriveOver,
  formatIndicatorSource,
  parseIndicatorSource,
  seriesAsBars,
} from '../../../src/indicators/derived.js';
import type { IndicatorResult } from '../../../src/indicators/types.js';
import { computeIndicator } from '../../../src/indicators/registry.js';
import { leadingNaN, wiggle } from './fixtures.js';

const BARS = wiggle(200);

describe('parsing a source reference', () => {
  it('reads a handle and a plot key out of one string', () => {
    expect(parseIndicatorSource('i3:rsi')).toEqual({ handleId: 'i3', plotKey: 'rsi' });
    expect(parseIndicatorSource('i12:plusDI')).toEqual({ handleId: 'i12', plotKey: 'plusDI' });
  });

  it('treats a price field as what it is, not a malformed reference', () => {
    // These are the values the same field has carried since before this existed; reading
    // one as a handle would point an SMA at an indicator called "close".
    for (const field of ['close', 'open', 'hl2', 'ohlc4']) {
      expect(parseIndicatorSource(field)).toBeNull();
    }
    expect(parseIndicatorSource(undefined)).toBeNull();
  });

  it('rejects the shapes that are not a reference either', () => {
    expect(parseIndicatorSource(':rsi')).toBeNull();
    expect(parseIndicatorSource('i3:')).toBeNull();
    expect(parseIndicatorSource(':')).toBeNull();
  });

  it('round-trips', () => {
    const source = { handleId: 'i7', plotKey: 'senkouB' };
    expect(parseIndicatorSource(formatIndicatorSource(source))).toEqual(source);
  });

  it('keeps a plot key that itself contains a colon in one piece', () => {
    // Split on the FIRST colon: the handle never has one, a plot key might.
    expect(parseIndicatorSource('i2:a:b')).toEqual({ handleId: 'i2', plotKey: 'a:b' });
  });
});

describe('projecting an indicator onto bars', () => {
  const rsi = computeIndicator('rsi', BARS, { period: 14 });

  it('carries every bar time through untouched', () => {
    const projected = seriesAsBars(BARS, rsi, 'rsi');
    expect(projected).not.toBeNull();
    if (projected === null) return;
    expect(projected).toHaveLength(BARS.length);
    for (let i = 0; i < BARS.length; i++) expect(projected[i].t).toBe(BARS[i].t);
  });

  it('puts the value in every price field, so any source setting reads the same', () => {
    // A derived series has no intrabar range. Inventing one would put a fake wick under
    // an ATR taken over it.
    const projected = seriesAsBars(BARS, rsi, 'rsi');
    if (projected === null) throw new Error('expected a projection');
    for (let i = 0; i < projected.length; i++) {
      const bar = projected[i];
      const value = rsi.values['rsi'][i];
      for (const field of [bar.o, bar.h, bar.l, bar.c]) {
        if (Number.isNaN(value)) expect(Number.isNaN(field)).toBe(true);
        else expect(field).toBe(value);
      }
    }
  });

  it('keeps the real volume, so a volume-weighted read still weights by what traded', () => {
    const projected = seriesAsBars(BARS, rsi, 'rsi');
    if (projected === null) throw new Error('expected a projection');
    for (let i = 0; i < projected.length; i++) expect(projected[i].v).toBe(BARS[i].v);
  });

  it('produces frozen bars, like every other bar in the app (mandate #4)', () => {
    const projected = seriesAsBars(BARS, rsi, 'rsi');
    if (projected === null) throw new Error('expected a projection');
    expect(Object.isFrozen(projected[0])).toBe(true);
  });

  it('refuses a plot that does not exist rather than inventing one', () => {
    expect(seriesAsBars(BARS, rsi, 'nope')).toBeNull();
  });

  it('refuses a length mismatch rather than reading the wrong bars', () => {
    // The dangerous case: a shorter array would silently pair values with bars they do
    // not belong to, and the result looks like a plausible curve that is simply wrong.
    expect(seriesAsBars(wiggle(50), rsi, 'rsi')).toBeNull();
  });
});

describe('an indicator computed over another indicator', () => {
  const rsi = computeIndicator('rsi', BARS, { period: 14 });
  const smaOverRsi = (period: number): IndicatorResult => {
    const derived = deriveOver(BARS, rsi, 'rsi', (over) =>
      computeIndicator('sma', over, { period }),
    );
    if (derived === null) throw new Error('expected a derived result');
    return derived;
  };

  it('is a different series from the same indicator over price', () => {
    const derived = smaOverRsi(9).values['sma'];
    const plain = computeIndicator('sma', BARS, { period: 9 }).values['sma'];
    let differences = 0;
    for (let i = 0; i < derived.length; i++) {
      if (Number.isNaN(derived[i]) || Number.isNaN(plain[i])) continue;
      if (Math.abs(derived[i] - plain[i]) > 1e-9) differences++;
    }
    expect(differences).toBeGreaterThan(100);
  });

  it('stays bar-aligned, one value per bar', () => {
    expect(smaOverRsi(9).values['sma']).toHaveLength(BARS.length);
  });

  it('smooths the source, and stays inside its range', () => {
    // An SMA of an RSI is bounded by the RSI's own 0..100 and is less jumpy than it.
    const smoothed = smaOverRsi(9).values['sma'];
    const raw = rsi.values['rsi'];

    let smoothedSwing = 0;
    let rawSwing = 0;
    for (let i = 1; i < smoothed.length; i++) {
      if (Number.isNaN(smoothed[i]) || Number.isNaN(smoothed[i - 1])) continue;
      expect(smoothed[i]).toBeGreaterThanOrEqual(0);
      expect(smoothed[i]).toBeLessThanOrEqual(100);
      smoothedSwing += Math.abs(smoothed[i] - smoothed[i - 1]);
      rawSwing += Math.abs(raw[i] - raw[i - 1]);
    }
    expect(smoothedSwing).toBeGreaterThan(0);
    expect(smoothedSwing).toBeLessThan(rawSwing * 0.8);
  });

  it('composes warm-up by addition, rather than swallowing the whole series', () => {
    // A 14-period RSI forms at index 14; a 9-period SMA over it needs nine formed values,
    // so the pair forms at 22. Handing the RSI's leading NaNs straight to the SMA instead
    // put a NaN into its running sum, and the result was empty for all 200 bars — late is
    // one bug, absent is another, and this pins the difference.
    const smoothed = smaOverRsi(9).values['sma'];
    const warmup = leadingNaN(rsi.values['rsi']);
    expect(leadingNaN(smoothed)).toBe(warmup + 8);
    expect(leadingNaN(smoothed)).toBeLessThan(BARS.length);
  });

  it('reports a warm-up that matches where its values actually start', () => {
    const derived = smaOverRsi(9);
    expect(derived.warmup).toBe(leadingNaN(derived.values['sma']));
  });

  it('agrees exactly with the same SMA over the RSI computed by hand', () => {
    // The arithmetic, not just the shape: each value is the mean of the nine RSI readings
    // ending at that bar.
    const smoothed = smaOverRsi(9).values['sma'];
    const raw = rsi.values['rsi'];
    let checked = 0;
    for (let i = 0; i < smoothed.length; i++) {
      if (Number.isNaN(smoothed[i])) continue;
      let sum = 0;
      for (let k = i - 8; k <= i; k++) sum += raw[k];
      expect(smoothed[i]).toBeCloseTo(sum / 9, 9);
      checked++;
    }
    expect(checked).toBeGreaterThan(150);
  });

  it('stacks three deep, each stage adding its own warm-up', () => {
    const first = smaOverRsi(9);
    const second = deriveOver(BARS, first, 'sma', (over) =>
      computeIndicator('sma', over, { period: 5 }),
    );
    expect(second).not.toBeNull();
    if (second === null) return;
    expect(second.values['sma']).toHaveLength(BARS.length);
    expect(leadingNaN(second.values['sma'])).toBe(leadingNaN(first.values['sma']) + 4);
  });

  it('expands every plot of a multi-plot indicator, not only the first', () => {
    const derived = deriveOver(BARS, rsi, 'rsi', (over) =>
      computeIndicator('bollinger', over, { period: 20 }),
    );
    expect(derived).not.toBeNull();
    if (derived === null) return;
    for (const plot of derived.plots) {
      expect(derived.values[plot.key], plot.key).toHaveLength(BARS.length);
    }
    // And the bands still bracket the basis, so the expansion did not shift one of them.
    const { upper, middle, lower } = derived.values;
    for (let i = 0; i < middle.length; i++) {
      if (Number.isNaN(middle[i])) continue;
      expect(upper[i]).toBeGreaterThanOrEqual(middle[i]);
      expect(lower[i]).toBeLessThanOrEqual(middle[i]);
    }
  });

  it('declines a source that never forms, rather than returning an empty overlay', () => {
    // A 500-period SMA over 200 bars has no values at all; deriving from it is not a
    // curve nobody can see, it is a request that cannot be answered.
    const never = computeIndicator('sma', BARS, { period: 500 });
    expect(deriveOver(BARS, never, 'sma', (over) => computeIndicator('sma', over, { period: 9 })))
      .toBeNull();
  });

  it('declines a plot that does not exist', () => {
    expect(deriveOver(BARS, rsi, 'nope', (over) => computeIndicator('sma', over, { period: 9 })))
      .toBeNull();
  });
});
