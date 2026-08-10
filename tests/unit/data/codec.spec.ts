import { describe, expect, it } from 'vitest';
import { createCodec, toFiniteNumber } from '../../../src/data/codec.js';
import { T0 } from './_helpers.js';

const good = [T0, 100, 110, 90, 105, 12.5] as const;

describe('codec — tuple decoding', () => {
  it('decodes the wire tuple into a frozen Bar and counts it', () => {
    const codec = createCodec();
    const bar = codec.decodeTuple([...good]);

    expect(bar).not.toBeNull();
    expect(Object.isFrozen(bar)).toBe(true);
    expect(bar?.t).toBe(T0);
    expect(bar?.c).toBe(105);
    expect(codec.stats().decoded).toBe(1);
    expect(codec.stats().dropped).toBe(0);
  });

  it('parses numeric strings once at the boundary (PostgreSQL numeric)', () => {
    const codec = createCodec();
    const bar = codec.decodeTuple([String(T0), '100.5', '110.25', '90', '105', '12.5']);

    expect(bar?.o).toBe(100.5);
    expect(typeof bar?.h).toBe('number');
    expect(codec.stats().dropped).toBe(0);
  });
});

describe('codec — malformed ticks are dropped and counted, never thrown', () => {
  it('rejects a non-array payload', () => {
    const codec = createCodec();
    expect(codec.decodeTuple('not a tuple')).toBeNull();
    expect(codec.decodeTuple(null)).toBeNull();
    expect(codec.stats().byReason.shape).toBe(2);
  });

  it('rejects the wrong arity', () => {
    const codec = createCodec();
    expect(codec.decodeTuple([T0, 100, 110, 90, 105])).toBeNull();
    expect(codec.decodeTuple([T0, 100, 110, 90, 105, 1, 7])).toBeNull();
    expect(codec.stats().byReason.arity).toBe(2);
  });

  it('rejects NaN, Infinity, null, booleans and empty strings in fields', () => {
    const codec = createCodec();
    expect(codec.decodeTuple([T0, Number.NaN, 110, 90, 105, 1])).toBeNull();
    expect(codec.decodeTuple([T0, 100, Number.POSITIVE_INFINITY, 90, 105, 1])).toBeNull();
    expect(codec.decodeTuple([T0, 100, 110, null, 105, 1])).toBeNull();
    expect(codec.decodeTuple([T0, 100, 110, 90, true, 1])).toBeNull();
    expect(codec.decodeTuple([T0, 100, 110, 90, 105, '   '])).toBeNull();
    expect(codec.stats().byReason.field).toBe(5);
    expect(codec.stats().decoded).toBe(0);
  });

  it('rejects OHLC invariant violations (§3.1)', () => {
    const codec = createCodec();
    // high below max(open, close)
    expect(codec.decodeTuple([T0, 100, 104, 90, 105, 1])).toBeNull();
    // low above min(open, close)
    expect(codec.decodeTuple([T0, 100, 110, 101, 105, 1])).toBeNull();
    // negative volume
    expect(codec.decodeTuple([T0, 100, 110, 90, 105, -1])).toBeNull();
    // non-integer timestamp
    expect(codec.decodeTuple([T0 + 0.5, 100, 110, 90, 105, 1])).toBeNull();
    expect(codec.stats().byReason.invariant).toBe(4);
  });

  it('keeps dropped == sum(byReason) and resets cleanly', () => {
    const codec = createCodec();
    codec.decodeTuple('nope');
    codec.decodeTuple([T0, 100, 110, 90, 105]);
    codec.decodeTuple([T0, 100, 104, 90, 105, 1]);
    const stats = codec.stats();
    const summed =
      stats.byReason.shape + stats.byReason.arity + stats.byReason.field + stats.byReason.invariant;

    expect(stats.dropped).toBe(summed);
    expect(stats.dropped).toBe(3);
    expect(Object.isFrozen(stats)).toBe(true);

    codec.reset();
    expect(codec.stats().dropped).toBe(0);
    expect(codec.stats().decoded).toBe(0);
  });
});

describe('codec — rows', () => {
  it('accepts object rows in both in-memory and SQL column naming', () => {
    const codec = createCodec();
    const short = codec.decodeRow({ t: T0, o: 100, h: 110, l: 90, c: 105, v: 1 });
    const sql = codec.decodeRow({
      ts: T0 + 60_000,
      open: '100',
      high: '110',
      low: '90',
      close: '105',
      volume: '1',
    });

    expect(short?.t).toBe(T0);
    expect(sql?.t).toBe(T0 + 60_000);
  });

  it('keeps the good rows of a mixed page and counts the bad ones', () => {
    const codec = createCodec();
    const bars = codec.decodeRows([
      [...good],
      [T0 + 60_000, 100, 104, 90, 105, 1], // invariant violation
      'garbage',
      [T0 + 120_000, 100, 110, 90, 105, 1],
    ]);

    expect(bars).toHaveLength(2);
    expect(codec.stats().decoded).toBe(2);
    expect(codec.stats().dropped).toBe(2);
  });

  it('drops a non-array page without throwing', () => {
    const codec = createCodec();
    expect(codec.decodeRows({ nope: true })).toHaveLength(0);
    expect(codec.stats().byReason.shape).toBe(1);
  });
});

describe('toFiniteNumber', () => {
  it('refuses the values Number() would silently turn into 0', () => {
    expect(toFiniteNumber('')).toBeNull();
    expect(toFiniteNumber(null)).toBeNull();
    expect(toFiniteNumber(false)).toBeNull();
    expect(toFiniteNumber([])).toBeNull();
    expect(toFiniteNumber('12.5')).toBe(12.5);
    expect(toFiniteNumber(-3)).toBe(-3);
  });
});
