import { describe, expect, it } from 'vitest';
import { asBarIndex, asPixel, asPrice } from '../../../src/data/types.js';
import { makeRect } from '../../../src/renderer/layout.js';
import {
  autoscale,
  expandDegenerate,
  makePriceRange,
  makePriceScale,
  percentBase,
} from '../../../src/renderer/scale/priceScale.js';
import { bar, makeBars } from './fixtures.js';

const plot = makeRect(0, 40, 700, 520);

describe('price scale — RENDER_ALGORITHMS §2', () => {
  it('maps pMax to the top of the plot and pMin to its bottom', () => {
    // 520 / (2.25 - 1.25) = 520 exactly, so both endpoints are exact in binary64.
    const scale = makePriceScale(makePriceRange(1.25, 2.25), plot, 'linear', asPrice(1));
    expect(scale.y(asPrice(2.25))).toBe(plot.top);
    expect(scale.y(asPrice(1.25))).toBe(plot.top + plot.height);
  });

  it('is monotone decreasing and unclamped outside the range', () => {
    const scale = makePriceScale(makePriceRange(100, 200), plot, 'linear', asPrice(1));
    expect(scale.y(asPrice(150))).toBeLessThan(scale.y(asPrice(140)));
    // A wick above the visible max must keep going up, not flatten onto the edge.
    expect(scale.y(asPrice(260))).toBeLessThan(plot.top);
    expect(scale.y(asPrice(40))).toBeGreaterThan(plot.top + plot.height);
  });

  it('round-trips Y⁻¹(Y(p)) across the domain', () => {
    const scale = makePriceScale(makePriceRange(98.5, 141.25), plot, 'linear', asPrice(1));
    for (let step = 0; step <= 200; step++) {
      const p = asPrice(98.5 + (141.25 - 98.5) * (step / 200));
      expect(Math.abs(scale.price(scale.y(p)) - p)).toBeLessThan(1e-9);
    }
  });

  it('round-trips Y(Y⁻¹(y)) across the plot height', () => {
    const scale = makePriceScale(makePriceRange(98.5, 141.25), plot, 'linear', asPrice(1));
    for (let step = 0; step <= 200; step++) {
      const y = asPixel(plot.top + (plot.height * step) / 200);
      expect(Math.abs(scale.y(scale.price(y)) - y)).toBeLessThan(1e-9);
    }
  });
});

describe('degenerate range guard — §2', () => {
  it('expands pMax === pMin by ±max(|pMax| * 1e-4, 1e-8)', () => {
    const expanded = expandDegenerate(50, 50);
    expect(expanded.max - expanded.min).toBeCloseTo(2 * 50 * 1e-4, 12);
    expect(expanded.max).toBeGreaterThan(50);
    expect(expanded.min).toBeLessThan(50);
  });

  it('uses the absolute floor when the price itself is zero', () => {
    const expanded = expandDegenerate(0, 0);
    expect(expanded.max).toBeCloseTo(1e-8, 20);
    expect(expanded.min).toBeCloseTo(-1e-8, 20);
  });

  it('leaves a healthy range untouched', () => {
    const expanded = expandDegenerate(10, 20);
    expect(expanded.min).toBe(10);
    expect(expanded.max).toBe(20);
  });

  it('never divides by zero when every visible bar has the same price', () => {
    const scale = makePriceScale(makePriceRange(42, 42), plot, 'linear', asPrice(1));
    const y: number = scale.y(asPrice(42));
    expect(Number.isFinite(y)).toBe(true);
    // The flat price lands in the middle of the plot.
    expect(y).toBeCloseTo(plot.top + plot.height / 2, 6);
    expect(Number.isFinite(scale.price(asPixel(plot.top)))).toBe(true);
  });

  it('survives a degenerate log range', () => {
    const scale = makePriceScale(makePriceRange(42, 42), plot, 'log', asPrice(42));
    const y: number = scale.y(asPrice(42));
    expect(Number.isFinite(y)).toBe(true);
    // The guard widens in price space, so on a log axis the centre lands a hundredth
    // of a pixel off mid-plot. Sub-pixel: invisible, and still finite and monotone.
    expect(Math.abs(y - (plot.top + plot.height / 2))).toBeLessThan(0.05);
  });
});

describe('log and percent scales — §3', () => {
  it('anchors both ends of the log domain to the plot', () => {
    const scale = makePriceScale(makePriceRange(10, 1000), plot, 'log', asPrice(10));
    expect(scale.y(asPrice(1000))).toBeCloseTo(plot.top, 9);
    expect(scale.y(asPrice(10))).toBeCloseTo(plot.top + plot.height, 9);
    // A decade is a constant number of pixels — that is the whole point of a log axis.
    const decadeA: number = scale.y(asPrice(10)) - scale.y(asPrice(100));
    const decadeB: number = scale.y(asPrice(100)) - scale.y(asPrice(1000));
    expect(decadeA).toBeCloseTo(decadeB, 9);
  });

  it('round-trips on a log scale', () => {
    const scale = makePriceScale(makePriceRange(0.5, 25_000), plot, 'log', asPrice(1));
    for (let step = 0; step <= 100; step++) {
      const p = asPrice(0.5 * Math.pow(50_000, step / 100));
      const back: number = scale.price(scale.y(p));
      expect(Math.abs(back - p) / p).toBeLessThan(1e-12);
    }
  });

  it('drops non-positive prices instead of clamping them', () => {
    const scale = makePriceScale(makePriceRange(1, 100), plot, 'log', asPrice(1));
    expect(scale.accepts(asPrice(0))).toBe(false);
    expect(scale.accepts(asPrice(-3))).toBe(false);
    expect(scale.accepts(asPrice(0.001))).toBe(true);
    expect(makePriceScale(makePriceRange(1, 100), plot, 'linear', asPrice(1)).accepts(asPrice(-3))).toBe(
      true,
    );
  });

  it('percent mode keeps log geometry and re-bases the displayed value', () => {
    const range = makePriceRange(80, 120);
    const log = makePriceScale(range, plot, 'log', asPrice(100));
    const percent = makePriceScale(range, plot, 'percent', asPrice(100));
    expect(percent.y(asPrice(110))).toBe(log.y(asPrice(110)));
    expect(percent.percentOf(asPrice(110))).toBeCloseTo(10, 9);
    expect(percent.percentOf(asPrice(90))).toBeCloseTo(-10, 9);
  });
});

describe('autoscale — §4', () => {
  it('pads the visible high/low range by 10% on each side', () => {
    const bars = [
      bar(1, 100, 110, 90, 105, 1),
      bar(2, 105, 120, 100, 118, 1),
      bar(3, 118, 130, 80, 90, 1), // low 80, high 130 -> pad 5
    ];
    const range = autoscale(bars, asBarIndex(0), asBarIndex(2));
    expect(range.min).toBeCloseTo(75, 9);
    expect(range.max).toBeCloseTo(135, 9);
  });

  it('only looks at the visible slice', () => {
    const bars = [
      bar(1, 100, 110, 90, 105, 1),
      bar(2, 105, 120, 100, 118, 1),
      bar(3, 118, 9_000, 80, 90, 1),
    ];
    const range = autoscale(bars, asBarIndex(0), asBarIndex(1));
    expect(range.max).toBeLessThan(200);
  });

  it('folds visible overlay extents into the range', () => {
    const bars = [bar(1, 100, 110, 90, 105, 1)];
    const range = autoscale(bars, asBarIndex(0), asBarIndex(0), makePriceRange(60, 200));
    expect(range.min).toBeCloseTo(60 - 14, 9);
    expect(range.max).toBeCloseTo(200 + 14, 9);
  });

  it('returns a finite unit range when nothing is visible', () => {
    const range = autoscale([], asBarIndex(0), asBarIndex(-1));
    expect(Number.isFinite(range.min)).toBe(true);
    expect(range.max).toBeGreaterThan(range.min);
  });

  it('produces a usable scale for a flat series (pad collapses to zero)', () => {
    const bars = [bar(1, 50, 50, 50, 50, 1), bar(2, 50, 50, 50, 50, 1)];
    const range = autoscale(bars, asBarIndex(0), asBarIndex(1));
    const scale = makePriceScale(range, plot, 'linear', asPrice(50));
    expect(Number.isFinite(scale.y(asPrice(50)))).toBe(true);
  });
});

describe('percent base', () => {
  it('uses the first visible bar close', () => {
    const bars = makeBars(10);
    expect(percentBase(bars, asBarIndex(3))).toBe(bars[3].c);
  });

  it('falls back to 1 when the index is out of range', () => {
    expect(percentBase([], asBarIndex(0))).toBe(1);
  });
});

describe('inverted price scale — §2.1', () => {
  it('swaps the endpoints: pMin at the top, pMax at the bottom', () => {
    const scale = makePriceScale(makePriceRange(1.25, 2.25), plot, 'linear', asPrice(1), true);
    expect(scale.y(asPrice(1.25))).toBe(plot.top);
    expect(scale.y(asPrice(2.25))).toBe(plot.top + plot.height);
  });

  it('is monotone INCREASING, and still unclamped', () => {
    const scale = makePriceScale(makePriceRange(100, 200), plot, 'linear', asPrice(1), true);
    expect(scale.y(asPrice(150))).toBeGreaterThan(scale.y(asPrice(140)));
    expect(scale.y(asPrice(260))).toBeGreaterThan(plot.top + plot.height);
    expect(scale.y(asPrice(40))).toBeLessThan(plot.top);
  });

  it('is the upright map reflected about the plot mid-line, exactly', () => {
    const upright = makePriceScale(makePriceRange(98.5, 141.25), plot, 'linear', asPrice(1));
    const flipped = makePriceScale(makePriceRange(98.5, 141.25), plot, 'linear', asPrice(1), true);
    for (let step = 0; step <= 100; step++) {
      const p = asPrice(98.5 + (141.25 - 98.5) * (step / 100));
      const mirrored = 2 * plot.top + plot.height - upright.y(p);
      expect(Math.abs(flipped.y(p) - mirrored)).toBeLessThan(1e-9);
    }
  });

  it('round-trips Y⁻¹(Y(p)) — the reflection is an involution', () => {
    const scale = makePriceScale(makePriceRange(98.5, 141.25), plot, 'linear', asPrice(1), true);
    for (let step = 0; step <= 200; step++) {
      const p = asPrice(98.5 + (141.25 - 98.5) * (step / 200));
      expect(Math.abs(scale.price(scale.y(p)) - p)).toBeLessThan(1e-9);
    }
  });

  it('inverts the log scale too, without a second set of equations', () => {
    const scale = makePriceScale(makePriceRange(10, 1000), plot, 'log', asPrice(10), true);
    expect(scale.y(asPrice(10))).toBeCloseTo(plot.top, 9);
    expect(scale.y(asPrice(1000))).toBeCloseTo(plot.top + plot.height, 9);
    // 100 is the geometric midpoint of [10, 1000], so it lands on the plot's mid-line
    // whichever way up the axis is.
    expect(scale.y(asPrice(100))).toBeCloseTo(plot.top + plot.height / 2, 9);
    expect(Math.abs(scale.price(scale.y(asPrice(250))) - 250)).toBeLessThan(1e-9);
  });

  it('keeps §3 rejection of non-positive prices when inverted', () => {
    const scale = makePriceScale(makePriceRange(10, 1000), plot, 'log', asPrice(10), true);
    expect(scale.accepts(asPrice(0))).toBe(false);
    expect(scale.accepts(asPrice(1))).toBe(true);
  });
});
