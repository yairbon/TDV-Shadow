import { describe, expect, it } from 'vitest';
import { canResample, foldIntoBucket, resample } from '../../../src/data/agg/resample.js';
import { alignToBarOpen } from '../../../src/data/types.js';
import type { Bar } from '../../../src/data/types.js';
import { bar, DAY, HOUR, MINUTE, T0 } from './_helpers.js';

/** n one-minute bars starting at `start`; close walks up so `last close` is checkable. */
const minutes = (start: number, count: number): readonly Bar[] => {
  const out: Bar[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(bar(start + i * MINUTE, 100 + i, 200, 50, 101 + i, 1));
  }
  return out;
};

describe('canResample', () => {
  it('allows whole multiples upward only', () => {
    expect(canResample('1m', '5m')).toBe(true);
    expect(canResample('1m', '1d')).toBe(true);
    expect(canResample('5m', '15m')).toBe(true);
    expect(canResample('4h', '1d')).toBe(true);
    expect(canResample('1m', '1m')).toBe(true);
    expect(canResample('5m', '1m')).toBe(false);
    expect(canResample('1d', '1h')).toBe(false);
  });

  it('returns nothing for an incompatible pair rather than throwing', () => {
    expect(resample(minutes(T0, 10), '1h', '1m')).toHaveLength(0);
  });
});

describe('resample — OHLCV rollup', () => {
  it('takes first open, max high, min low, last close and summed volume', () => {
    const bars = [
      bar(T0 + 0 * MINUTE, 100, 105, 99, 104, 1),
      bar(T0 + 1 * MINUTE, 104, 120, 95, 110, 2),
      bar(T0 + 2 * MINUTE, 110, 112, 90, 91, 4),
      bar(T0 + 3 * MINUTE, 91, 115, 91, 113, 8),
      bar(T0 + 4 * MINUTE, 113, 118, 100, 117, 16),
    ];

    const rolled = resample(bars, '1m', '5m');

    expect(rolled).toHaveLength(1);
    const b = rolled[0];
    expect(b.t).toBe(T0);
    expect(b.o).toBe(100); // first open
    expect(b.h).toBe(120); // max high
    expect(b.l).toBe(90); // min low
    expect(b.c).toBe(117); // last close
    expect(b.v).toBe(31); // summed volume
    expect(Object.isFrozen(b)).toBe(true);
  });

  it('is the identity for an equal timeframe', () => {
    const bars = minutes(T0, 3);
    expect(resample(bars, '1m', '1m')).toBe(bars);
  });
});

describe('resample — bucket boundaries', () => {
  it('cuts exactly on the 5m boundary, not one bar early or late', () => {
    const rolled = resample(minutes(T0, 10), '1m', '5m');

    expect(rolled.map((b) => b.t)).toEqual([T0, T0 + 5 * MINUTE]);
    expect(rolled[0].o).toBe(100); // minute 0
    expect(rolled[0].c).toBe(105); // minute 4
    expect(rolled[1].o).toBe(105); // minute 5 opens the next bucket
    expect(rolled[1].c).toBe(110); // minute 9
    expect(rolled[0].v).toBe(5);
    expect(rolled[1].v).toBe(5);
  });

  it('emits a bucket holding a single bar', () => {
    const rolled = resample(minutes(T0, 6), '1m', '5m');

    expect(rolled).toHaveLength(2);
    expect(rolled[1].t).toBe(T0 + 5 * MINUTE);
    expect(rolled[1].v).toBe(1);
    expect(rolled[1].o).toBe(105);
    expect(rolled[1].c).toBe(106);
  });

  it('splits a run that crosses a day boundary into two 1d bars', () => {
    // 23:58, 23:59 of one UTC day, then 00:00, 00:01 of the next.
    const start = T0 + DAY - 2 * MINUTE;
    const rolled = resample(minutes(start, 4), '1m', '1d');

    expect(rolled).toHaveLength(2);
    expect(rolled[0].t).toBe(T0);
    expect(rolled[1].t).toBe(T0 + DAY);
    expect(rolled[0].v).toBe(2);
    expect(rolled[1].v).toBe(2);
    expect(rolled[0].c).toBe(102); // last close before midnight
    expect(rolled[1].o).toBe(102); // first open after midnight
    expect(alignToBarOpen(start, '1d')).toBe(T0);
  });

  it('starts a new bucket for a bar landing exactly on the hour', () => {
    const bars = [bar(T0 + 59 * MINUTE, 100, 110, 90, 105, 1), bar(T0 + HOUR, 100, 110, 90, 105, 1)];
    const rolled = resample(bars, '1m', '1h');

    expect(rolled.map((b) => b.t)).toEqual([T0, T0 + HOUR]);
  });

  it('leaves a hole a hole — a missing period produces no bar', () => {
    const bars = [...minutes(T0, 2), ...minutes(T0 + 3 * HOUR, 2)];
    const rolled = resample(bars, '1m', '1h');

    expect(rolled.map((b) => b.t)).toEqual([T0, T0 + 3 * HOUR]);
  });

  it('drops a bar that goes backwards instead of corrupting its bucket', () => {
    const bars = [bar(T0 + 2 * MINUTE, 100, 110, 90, 105, 1), bar(T0, 100, 900, 1, 105, 99)];
    const rolled = resample(bars, '1m', '5m');

    expect(rolled).toHaveLength(1);
    expect(rolled[0].h).toBe(110);
    expect(rolled[0].v).toBe(1);
  });

  it('handles an empty input', () => {
    expect(resample([], '1m', '1h')).toHaveLength(0);
  });
});

describe('foldIntoBucket — incremental live rollup', () => {
  it('folds into the open bucket without mutating the aggregate', () => {
    const first = foldIntoBucket(null, bar(T0, 100, 105, 99, 104, 1), '5m');
    expect(first?.t).toBe(T0);

    const second = foldIntoBucket(first, bar(T0 + MINUTE, 104, 120, 95, 110, 2), '5m');

    expect(second?.o).toBe(100);
    expect(second?.h).toBe(120);
    expect(second?.l).toBe(95);
    expect(second?.c).toBe(110);
    expect(second?.v).toBe(3);
    expect(second).not.toBe(first);
    expect(first?.h).toBe(105); // untouched
    expect(Object.isFrozen(second)).toBe(true);
  });

  it('opens a fresh bucket when the bar crosses the boundary', () => {
    const open = foldIntoBucket(null, bar(T0 + 4 * MINUTE, 100, 105, 99, 104, 1), '5m');
    const next = foldIntoBucket(open, bar(T0 + 5 * MINUTE, 104, 106, 103, 105, 2), '5m');

    expect(next?.t).toBe(T0 + 5 * MINUTE);
    expect(next?.o).toBe(104);
    expect(next?.v).toBe(2);
  });
});
