import { describe, expect, it } from 'vitest';
import { asBarIndex, asPrice } from '../../../src/data/types.js';
import { makeRect } from '../../../src/renderer/layout.js';
import { makePriceRange, makePriceScale } from '../../../src/renderer/scale/priceScale.js';
import { makeTimeScale } from '../../../src/renderer/scale/timeScale.js';
import {
  chooseTimeUnit,
  formatCrosshairTime,
  formatPrice,
  niceStep,
  priceTicks,
  targetTickCount,
  tickDecimals,
  timeTicks,
} from '../../../src/renderer/scale/ticks.js';
import { bar, FIXTURE_START, makeBars } from './fixtures.js';

const plot = makeRect(0, 0, 700, 500);
const LINE_HEIGHT = 14;

describe('nice price steps — RENDER_ALGORITHMS §8', () => {
  it('only ever emits the 1 / 2 / 2.5 / 5 / 10 mantissa set', () => {
    for (let i = 1; i <= 4_000; i++) {
      const step = niceStep(i / 37);
      const mantissa = step / Math.pow(10, Math.floor(Math.log10(step)));
      expect([1, 2, 2.5, 5, 10]).toContain(Math.round(mantissa * 100) / 100);
    }
  });

  it('matches the worked cases', () => {
    expect(niceStep(1)).toBe(1);
    expect(niceStep(1.5)).toBe(2);
    expect(niceStep(2.4)).toBe(2.5);
    expect(niceStep(3)).toBe(5);
    expect(niceStep(7)).toBe(10);
    expect(niceStep(0.021)).toBeCloseTo(0.025, 12);
    expect(niceStep(1_700)).toBe(2_000);
  });

  it('refuses to produce a step for a degenerate raw interval', () => {
    expect(niceStep(0)).toBe(0);
    expect(niceStep(Number.NaN)).toBe(0);
  });

  it('targets at least two ticks however short the plot is', () => {
    expect(targetTickCount(500, LINE_HEIGHT)).toBe(22);
    expect(targetTickCount(10, LINE_HEIGHT)).toBe(2);
    expect(targetTickCount(0, LINE_HEIGHT)).toBe(2);
  });

  it('derives label decimals from the step, capped by the instrument precision', () => {
    expect(tickDecimals(1, 8)).toBe(0);
    expect(tickDecimals(0.5, 8)).toBe(1);
    expect(tickDecimals(0.025, 8)).toBe(2);
    expect(tickDecimals(0.001, 8)).toBe(3);
    expect(tickDecimals(0.001, 1)).toBe(1); // instrument precision wins
    expect(formatPrice(1.5, 2)).toBe('1.50');
  });
});

describe('price ticks', () => {
  const ranges: readonly (readonly [number, number])[] = [
    [100, 200],
    [0.0001, 0.0009],
    [61_230.5, 61_290],
    [-40, 40],
    [1.25, 1.2503],
    [0, 1],
  ];

  it('produces ascending, in-range, evenly spaced ticks for every range', () => {
    for (const [min, max] of ranges) {
      const scale = makePriceScale(makePriceRange(min, max), plot, 'linear', asPrice(1));
      const ticks = priceTicks(scale, LINE_HEIGHT, 8);
      expect(ticks.length).toBeGreaterThan(0);
      for (const tick of ticks) {
        expect(tick.price).toBeGreaterThanOrEqual(scale.min - 1e-9);
        expect(tick.price).toBeLessThanOrEqual(scale.max + 1e-9);
        expect(tick.y).toBeGreaterThanOrEqual(plot.top - 1e-9);
        expect(tick.y).toBeLessThanOrEqual(plot.top + plot.height + 1e-9);
      }
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].price).toBeGreaterThan(ticks[i - 1].price);
        const gapA = ticks[i].price - ticks[i - 1].price;
        const gapB = ticks[1].price - ticks[0].price;
        expect(Math.abs(gapA - gapB)).toBeLessThan(Math.abs(gapB) * 1e-9);
      }
    }
  });

  it('keeps labels from touching: ticks are at least one line box apart', () => {
    for (const [min, max] of ranges) {
      const scale = makePriceScale(makePriceRange(min, max), plot, 'linear', asPrice(1));
      const ticks = priceTicks(scale, LINE_HEIGHT, 8);
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i - 1].y - ticks[i].y).toBeGreaterThanOrEqual(LINE_HEIGHT);
      }
    }
  });

  it('labels a round range with round numbers', () => {
    const scale = makePriceScale(makePriceRange(100, 200), plot, 'linear', asPrice(1));
    const labels = priceTicks(scale, LINE_HEIGHT, 8).map((t) => t.label);
    expect(labels).toContain('100');
    expect(labels).toContain('150');
    expect(labels).toContain('200');
  });

  it('generates log ticks per decade from the same mantissa set', () => {
    const scale = makePriceScale(makePriceRange(1, 1_000), plot, 'log', asPrice(1));
    const ticks = priceTicks(scale, LINE_HEIGHT, 8);
    expect(ticks.length).toBeGreaterThan(3);
    for (const tick of ticks) {
      const mag = Math.pow(10, Math.floor(Math.log10(tick.price)));
      const mantissa = Math.round((tick.price / mag) * 100) / 100;
      expect([1, 2, 2.5, 5]).toContain(mantissa);
      expect(tick.y).toBeGreaterThanOrEqual(plot.top - 1e-9);
      expect(tick.y).toBeLessThanOrEqual(plot.top + plot.height + 1e-9);
    }
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i - 1].y - ticks[i].y).toBeGreaterThanOrEqual(LINE_HEIGHT * 1.6);
    }
  });
});

describe('log ticks on a sub-decade window', () => {
  it('still fills the axis when the mantissa set offers nothing', () => {
    const scale = makePriceScale(makePriceRange(95, 105), plot, 'log', asPrice(100));
    const ticks = priceTicks(scale, LINE_HEIGHT, 2);
    expect(ticks.length).toBeGreaterThan(2);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i - 1].y - ticks[i].y).toBeGreaterThanOrEqual(LINE_HEIGHT);
      expect(ticks[i].price).toBeGreaterThan(ticks[i - 1].price);
    }
    for (const tick of ticks) {
      // Positions come from the log transform, not from a linear one.
      expect(tick.y).toBeCloseTo(scale.y(tick.price), 9);
    }
  });
});

describe('time tick unit selection', () => {
  const MINUTE = 60_000;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;

  it('coarsens the unit until ticks are at least 60px apart', () => {
    // 1m bars at 8px/bar: an hour is 480px, but 15m is already 120px >= 60.
    expect(chooseTimeUnit(8, MINUTE, 60).id).toBe('15m');
    expect(chooseTimeUnit(60, MINUTE, 60).id).toBe('1m');
    expect(chooseTimeUnit(1, MINUTE, 60).id).toBe('1h');
    expect(chooseTimeUnit(0.5, MINUTE, 60).id).toBe('2h');
  });

  it('never picks a unit finer than the timeframe itself', () => {
    for (const spacing of [0.5, 1, 4, 12, 40, 120]) {
      expect(chooseTimeUnit(spacing, DAY, 60).ms).toBeGreaterThanOrEqual(DAY);
      expect(chooseTimeUnit(spacing, HOUR, 60).ms).toBeGreaterThanOrEqual(HOUR);
    }
  });

  it('always yields a unit whose spacing clears the minimum, when one exists', () => {
    for (const spacing of [0.5, 2, 8, 30, 120]) {
      const unit = chooseTimeUnit(spacing, MINUTE, 60);
      expect((unit.ms / MINUTE) * spacing).toBeGreaterThanOrEqual(60);
    }
  });
});

describe('time ticks', () => {
  it('marks period boundaries only, never every bar', () => {
    const bars = makeBars(600, 60_000);
    const scale = makeTimeScale(bars.length - 1, 8, plot);
    const range = scale.visibleRange(bars.length);
    const ticks = timeTicks(bars, range, scale, 60_000, 60).ticks;

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(range.count);
    for (const tick of ticks) {
      const t: number = bars[tick.index].t;
      expect(t % 900_000).toBe(0); // 15m boundaries at 8px/bar
      expect(tick.index).toBeGreaterThanOrEqual(range.from);
      expect(tick.index).toBeLessThanOrEqual(range.to);
    }
  });

  it('labels a day boundary with the DATE, even on an intraday chart', () => {
    // A 5-minute series zoomed out over weeks chooses a 6-hour unit, and because the data
    // only exists during sessions the period key changes once per session — at the same
    // clock time every day. Labelling those by clock printed "13:30" across the entire
    // axis, which locates nothing. Reproduced here with 5m bars over several days.
    const bars = makeBars(3_000, 300_000);
    const scale = makeTimeScale(bars.length - 1, 1, plot);
    const range = scale.visibleRange(bars.length);
    const ticks = timeTicks(bars, range, scale, 300_000, 60).ticks;

    expect(ticks.length).toBeGreaterThan(2);
    const labels = ticks.map((tick) => tick.label);
    // Not one repeated clock time.
    expect(new Set(labels).size).toBeGreaterThan(1);
    // And the ones that cross a day read as a date, not a time.
    expect(labels.some((label) => !label.includes(':'))).toBe(true);
  });

  it('still labels a within-day tick with the clock', () => {
    // The promotion must not swallow the ordinary case: minute bars at a readable zoom
    // tick several times inside one day, and those are clock times.
    const bars = makeBars(300, 60_000);
    const scale = makeTimeScale(bars.length - 1, 8, plot);
    const range = scale.visibleRange(bars.length);
    const ticks = timeTicks(bars, range, scale, 60_000, 60).ticks;
    expect(ticks.some((tick) => tick.label.includes(':'))).toBe(true);
  });

  it('keeps labels at least the minimum spacing apart', () => {
    for (const spacing of [0.5, 1, 3, 8, 30, 120]) {
      const bars = makeBars(4_000, 60_000);
      const scale = makeTimeScale(bars.length - 1, spacing, plot);
      const range = scale.visibleRange(bars.length);
      const ticks = timeTicks(bars, range, scale, 60_000, 60).ticks;
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i].x - ticks[i - 1].x).toBeGreaterThanOrEqual(60);
      }
    }
  });

  it('emphasises month and year boundaries and labels them in UTC', () => {
    // Daily bars across a new year: 2025-12-29 .. 2026-01-05
    const start = Date.UTC(2025, 11, 29);
    const bars = [];
    for (let i = 0; i < 8; i++) {
      bars.push(bar(start + i * 86_400_000, 100, 101, 99, 100.5, 10));
    }
    const scale = makeTimeScale(bars.length - 1, 90, plot);
    const range = scale.visibleRange(bars.length);
    const ticks = timeTicks(bars, range, scale, 86_400_000, 60).ticks;
    const major = ticks.filter((t) => t.major);
    expect(major.length).toBe(1);
    expect(major[0].label).toBe('2026');
    expect(bars[major[0].index].t).toBe(Date.UTC(2026, 0, 1));
  });

  it('returns nothing for an empty range', () => {
    const scale = makeTimeScale(0, 8, plot);
    expect(timeTicks([], scale.visibleRange(0), scale, 60_000, 60).ticks).toHaveLength(0);
  });

  it('formats the crosshair stamp in UTC', () => {
    expect(formatCrosshairTime(FIXTURE_START, 60_000)).toBe('11 Aug 00:00');
    expect(formatCrosshairTime(FIXTURE_START, 86_400_000)).toBe('11 Aug 2025');
  });
});

describe('session breaks and timezone — 10.2', () => {
  /** Three UTC days of hourly bars, starting at midnight UTC. */
  const hourly = (() => {
    const start = Date.UTC(2026, 0, 12, 0, 0);
    const out = [];
    for (let i = 0; i < 72; i++) out.push(bar(start + i * 3_600_000, 100, 101, 99, 100.5, 10));
    return out;
  })();

  const axisFor = (zone: string) => {
    const scale = makeTimeScale(hourly.length - 1, 9, plot);
    return timeTicks(hourly, scale.visibleRange(hourly.length), scale, 3_600_000, 60, zone);
  };

  it('marks one session break per calendar day boundary', () => {
    // 72 hourly bars spanning three days have two interior midnights.
    expect(axisFor('UTC').sessionBreaks).toHaveLength(2);
  });

  it('moves the break when the display timezone changes', () => {
    // Midnight in Tokyo is 15:00 UTC, so the separators land on different bars — the
    // whole point of a display timezone on an intraday chart. The same 72-hour window
    // even contains a different NUMBER of Tokyo midnights (three) than UTC ones (two),
    // because the window starts mid-morning in Tokyo.
    const utc = axisFor('UTC').sessionBreaks;
    const tokyo = axisFor('Asia/Tokyo').sessionBreaks;
    expect(utc).toHaveLength(2);
    expect(tokyo).toHaveLength(3);
    for (const x of tokyo) expect(utc).not.toContain(x);
  });

  it('emits no session breaks for daily bars, where every bar is its own day', () => {
    const daily = [];
    const start = Date.UTC(2026, 0, 1);
    for (let i = 0; i < 30; i++) daily.push(bar(start + i * 86_400_000, 100, 101, 99, 100.5, 10));
    const scale = makeTimeScale(daily.length - 1, 20, plot);
    const axis = timeTicks(daily, scale.visibleRange(daily.length), scale, 86_400_000, 60);
    expect(axis.sessionBreaks).toHaveLength(0);
  });

  it('labels intraday ticks in the display timezone', () => {
    const utc = axisFor('UTC').ticks;
    const tokyo = axisFor('Asia/Tokyo').ticks;
    expect(utc.length).toBeGreaterThan(0);
    expect(tokyo.length).toBeGreaterThan(0);
    // Same bars, same geometry, different clock faces.
    expect(tokyo.map((t) => t.label)).not.toEqual(utc.map((t) => t.label));
  });

  it('a weekend gap consumes no width (§5 index space)', () => {
    // The other half of 10.2, and it is a property of index space rather than of new
    // code: Friday and the following Monday are adjacent INDICES, so they are exactly one
    // bar apart on screen no matter how many days of wall clock separate them.
    const friday = Date.UTC(2026, 0, 9);
    const bars = [
      bar(friday, 100, 101, 99, 100.5, 10),
      bar(friday + 3 * 86_400_000, 100, 101, 99, 100.5, 10),
      bar(friday + 4 * 86_400_000, 100, 101, 99, 100.5, 10),
    ];
    const scale = makeTimeScale(bars.length - 1, 20, plot);
    expect(scale.x(asBarIndex(1)) - scale.x(asBarIndex(0))).toBeCloseTo(20, 9);
    expect(scale.x(asBarIndex(2)) - scale.x(asBarIndex(1))).toBeCloseTo(20, 9);
  });

  it('formats the crosshair stamp in the display timezone', () => {
    const t = Date.UTC(2026, 0, 15, 12, 0);
    expect(formatCrosshairTime(t, 3_600_000, 'UTC')).toContain('12:00');
    expect(formatCrosshairTime(t, 3_600_000, 'America/New_York')).toContain('07:00');
  });
});
