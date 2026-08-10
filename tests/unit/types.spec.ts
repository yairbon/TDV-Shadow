import { describe, expect, it } from 'vitest';
import { alignToBarOpen, barFromTuple, makeBar, TIMEFRAME_MS } from '../../src/data/types.js';

const valid = { t: 1_754_870_400_000, o: 100, h: 110, l: 95, c: 105, v: 12.5 };

describe('makeBar', () => {
  it('accepts a well-formed bar and freezes it', () => {
    const bar = makeBar(valid);
    expect(bar).not.toBeNull();
    expect(Object.isFrozen(bar)).toBe(true);
  });

  it('rejects high below max(open, close)', () => {
    expect(makeBar({ ...valid, h: 104 })).toBeNull();
  });

  it('rejects low above min(open, close)', () => {
    expect(makeBar({ ...valid, l: 101 })).toBeNull();
  });

  it('rejects NaN / Infinity rather than leaking them into the render path', () => {
    expect(makeBar({ ...valid, c: Number.NaN })).toBeNull();
    expect(makeBar({ ...valid, o: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it('rejects negative volume and non-integer timestamps', () => {
    expect(makeBar({ ...valid, v: -1 })).toBeNull();
    expect(makeBar({ ...valid, t: 1.5 })).toBeNull();
  });

  it('accepts a doji where open === high === low === close', () => {
    expect(makeBar({ t: valid.t, o: 100, h: 100, l: 100, c: 100, v: 0 })).not.toBeNull();
  });
});

describe('barFromTuple', () => {
  it('maps the wire tuple in [t,o,h,l,c,v] order', () => {
    const bar = barFromTuple([valid.t, 100, 110, 95, 105, 12.5]);
    expect(bar?.o).toBe(100);
    expect(bar?.h).toBe(110);
    expect(bar?.l).toBe(95);
    expect(bar?.c).toBe(105);
  });
});

describe('alignToBarOpen', () => {
  it('floors a timestamp to its bar open', () => {
    const mid = 1_754_870_400_000 + 37_000;
    expect(alignToBarOpen(mid, '1m')).toBe(1_754_870_400_000);
  });

  it('is idempotent on an already-aligned timestamp', () => {
    const t = alignToBarOpen(1_754_870_437_000, '1h');
    expect(alignToBarOpen(t, '1h')).toBe(t);
  });

  it('uses exact timeframe durations', () => {
    expect(TIMEFRAME_MS['1d']).toBe(86_400_000);
    expect(TIMEFRAME_MS['4h']).toBe(4 * TIMEFRAME_MS['1h']);
  });
});
