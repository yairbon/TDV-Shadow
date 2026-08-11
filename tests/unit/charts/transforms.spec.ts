import { describe, expect, it } from 'vitest';

import { makeBar, type Bar } from '../../../src/data/types.js';
import { applyChartType, TRANSFORMS } from '../../../src/charts/registry.js';
import { heikinAshiBars } from '../../../src/charts/heikinAshi.js';
import { CHART_TYPES, timeOf, type ChartType } from '../../../src/charts/types.js';

const START = 1_754_870_400_000;
const STEP = 60_000;

function bar(i: number, o: number, h: number, l: number, c: number, v = 10): Bar {
  const made = makeBar({ t: START + i * STEP, o, h, l, c, v });
  if (made === null) throw new Error(`invalid fixture bar at ${String(i)}`);
  return made;
}

/** A deliberately volatile series so the price-driven types actually produce bars. */
function series(count = 120): Bar[] {
  const out: Bar[] = [];
  let price = 100;
  for (let i = 0; i < count; i++) {
    const drift = Math.sin(i / 4) * 1.5 + (i % 7 === 0 ? -2 : 0.4);
    const open = price;
    const close = price + drift;
    out.push(bar(i, open, Math.max(open, close) + 0.6, Math.min(open, close) - 0.6, close));
    price = close;
  }
  return out;
}

const ONE_TO_ONE: ChartType[] = [
  'candles',
  'hollow-candles',
  'bars',
  'line',
  'area',
  'baseline',
  'step-line',
  'columns',
  'heikin-ashi',
];

describe('every chart type', () => {
  const bars = series();

  it.each(CHART_TYPES)('%s emits bars satisfying the OHLC invariants', (type) => {
    const derived = applyChartType(type, bars, {});
    expect(derived.bars.length).toBeGreaterThan(0);
    for (const b of derived.bars) {
      expect(b.h).toBeGreaterThanOrEqual(Math.max(b.o, b.c));
      expect(b.l).toBeLessThanOrEqual(Math.min(b.o, b.c));
      expect(b.h).toBeGreaterThanOrEqual(b.l);
      expect(Number.isFinite(b.o)).toBe(true);
      expect(Number.isFinite(b.c)).toBe(true);
    }
  });

  it.each(CHART_TYPES)('%s freezes every emitted bar (mandate #4)', (type) => {
    const derived = applyChartType(type, bars, {});
    for (const b of derived.bars) expect(Object.isFrozen(b)).toBe(true);
  });

  it.each(CHART_TYPES)('%s keeps sourceIndex in range and non-decreasing', (type) => {
    const derived = applyChartType(type, bars, {});
    let previous = -1;
    for (const b of derived.bars) {
      expect(b.sourceIndex).toBeGreaterThanOrEqual(0);
      expect(b.sourceIndex).toBeLessThan(bars.length);
      expect(b.sourceIndex).toBeGreaterThanOrEqual(previous);
      previous = b.sourceIndex;
    }
  });

  it.each(CHART_TYPES)('%s resolves non-decreasing timestamps through timeOf', (type) => {
    // This is the drift bug: for resampling types the Nth output bar is NOT the Nth
    // input bar, so a time axis that labels by position silently lies.
    const derived = applyChartType(type, bars, {});
    let previous = -1;
    for (const b of derived.bars) {
      const t = timeOf(b, bars);
      expect(t).toBeGreaterThanOrEqual(previous);
      previous = t;
    }
  });

  it.each(CHART_TYPES)('%s survives empty input without throwing', (type) => {
    const derived = applyChartType(type, [], {});
    expect(derived.bars.length).toBe(0);
  });

  it.each(CHART_TYPES)('%s survives single-bar input', (type) => {
    expect(() => applyChartType(type, [bar(0, 100, 101, 99, 100.5)], {})).not.toThrow();
  });

  it.each(CHART_TYPES)('%s declares the index-space contract the registry promises', (type) => {
    const derived = applyChartType(type, bars, {});
    expect(derived.preservesIndexSpace).toBe(TRANSFORMS[type].preservesIndexSpace);
  });
});

describe('1:1 chart types', () => {
  const bars = series(40);

  it.each(ONE_TO_ONE)('%s emits exactly one bar per input bar with identity mapping', (type) => {
    const derived = applyChartType(type, bars, {});
    expect(derived.preservesIndexSpace).toBe(true);
    expect(derived.bars.length).toBe(bars.length);
    derived.bars.forEach((b, i) => {
      expect(b.sourceIndex).toBe(i);
      expect(b.t).toBe(bars[i].t);
    });
  });
});

describe('Heikin Ashi', () => {
  it('seeds the first open at (o + c) / 2, not the raw open', () => {
    const input = [bar(0, 100, 110, 90, 106)];
    const [first] = heikinAshiBars(input);
    expect(first.o).toBeCloseTo((100 + 106) / 2, 10);
    expect(first.c).toBeCloseTo((100 + 110 + 90 + 106) / 4, 10);
  });

  it('averages the previous HA open and close for subsequent bars', () => {
    const input = [bar(0, 100, 110, 90, 106), bar(1, 106, 112, 104, 108)];
    const ha = heikinAshiBars(input);
    const expectedOpen = (ha[0].o + ha[0].c) / 2;
    expect(ha[1].o).toBeCloseTo(expectedOpen, 10);
    expect(ha[1].c).toBeCloseTo((106 + 112 + 104 + 108) / 4, 10);
    expect(ha[1].h).toBeCloseTo(Math.max(112, ha[1].o, ha[1].c), 10);
    expect(ha[1].l).toBeCloseTo(Math.min(104, ha[1].o, ha[1].c), 10);
  });

  it('smooths direction — HA flips between up and down less often than the raw bars', () => {
    // The real Heikin Ashi property. An earlier version of this test asserted HA bodies
    // are SMALLER than raw bodies, which is false: HA opens at the midpoint of the
    // previous body, so in a trend its bodies are typically larger. What HA actually
    // reduces is the number of direction changes.
    const bars = series(80);
    const ha = heikinAshiBars(bars);
    const flips = (xs: readonly { o: number; c: number }[]): number => {
      let n = 0;
      for (let i = 1; i < xs.length; i++) {
        if (xs[i].c >= xs[i].o !== (xs[i - 1].c >= xs[i - 1].o)) n++;
      }
      return n;
    };
    expect(flips(ha)).toBeLessThan(flips(bars));
  });
});

describe('Renko', () => {
  const bars = series(120);

  it('emits bricks of exactly the configured size', () => {
    const derived = applyChartType('renko', bars, { brickSize: 1 });
    expect(derived.bars.length).toBeGreaterThan(3);
    for (const b of derived.bars) {
      expect(Math.abs(b.c - b.o)).toBeCloseTo(1, 9);
    }
  });

  it('needs two bricks to reverse, so direction does not flip on noise', () => {
    // Up 3 bricks, then a 1-brick pullback: a correct implementation emits nothing for
    // the pullback, because reversing costs two.
    const input = [bar(0, 100, 100, 100, 100), bar(1, 103, 103, 103, 103), bar(2, 102, 102, 102, 102)];
    const derived = applyChartType('renko', input, { brickSize: 1 });
    expect(derived.bars.every((b) => b.rising)).toBe(true);
  });

  it('falls back to an ATR-derived brick when none is configured', () => {
    const derived = applyChartType('renko', bars, { brickSize: null });
    expect(derived.bars.length).toBeGreaterThan(0);
  });
});

describe('Line Break', () => {
  it('only breaks when the close clears the previous N lines', () => {
    const derived = applyChartType('line-break', series(120), { lineBreaks: 3 });
    expect(derived.bars.length).toBeGreaterThan(0);
    // Consecutive lines never repeat the same close: a break requires new ground.
    for (let i = 1; i < derived.bars.length; i++) {
      expect(derived.bars[i].c).not.toBe(derived.bars[i - 1].c);
    }
  });
});

describe('Point & Figure', () => {
  it('alternates column direction', () => {
    const derived = applyChartType('point-and-figure', series(160), {
      boxSize: 1,
      reversalBoxes: 3,
    });
    expect(derived.bars.length).toBeGreaterThan(1);
    for (let i = 1; i < derived.bars.length; i++) {
      expect(derived.bars[i].rising).not.toBe(derived.bars[i - 1].rising);
    }
  });
});

describe('Range bars', () => {
  it('each bar spans at least the configured range', () => {
    const derived = applyChartType('range', series(160), { brickSize: 2 });
    expect(derived.bars.length).toBeGreaterThan(0);
    for (const b of derived.bars) expect(b.h - b.l).toBeGreaterThanOrEqual(2 - 1e-9);
  });
});
