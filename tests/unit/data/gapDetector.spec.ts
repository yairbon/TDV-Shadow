import { describe, expect, it } from 'vitest';
import { createGapDetector } from '../../../src/data/ws/gapDetector.js';
import { asTimeMs } from '../../../src/data/types.js';
import { MINUTE, T0 } from './_helpers.js';

const at = (n: number): ReturnType<typeof asTimeMs> => asTimeMs(T0 + n * MINUTE);

describe('gapDetector — monotonic seq per (symbol, timeframe)', () => {
  it('treats the first frame as a baseline, not a gap', () => {
    const detector = createGapDetector();
    const verdict = detector.observe('BTCUSD', '1m', 500, at(0));

    expect(verdict.kind).toBe('first');
    expect(detector.lastSeq('BTCUSD', '1m')).toBe(500);
    expect(detector.isStale('BTCUSD', '1m')).toBe(false);
  });

  it('accepts consecutive sequence numbers', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 1, at(0));
    expect(detector.observe('BTCUSD', '1m', 2, at(1)).kind).toBe('in-order');
    expect(detector.observe('BTCUSD', '1m', 3, at(2)).kind).toBe('in-order');
    expect(detector.stats().accepted).toBe(3);
    expect(detector.stats().gaps).toBe(0);
  });

  it('drops replays without rewinding state', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 10, at(0));
    detector.observe('BTCUSD', '1m', 11, at(1));

    const verdict = detector.observe('BTCUSD', '1m', 11, at(1));
    expect(verdict.kind).toBe('duplicate');
    expect(detector.lastSeq('BTCUSD', '1m')).toBe(11);
    expect(detector.lastGoodTime('BTCUSD', '1m')).toBe(at(1));
    expect(detector.stats().duplicates).toBe(1);
  });

  it('drops a non-integer or negative seq as invalid', () => {
    const detector = createGapDetector();
    expect(detector.observe('BTCUSD', '1m', 1.5, at(0)).kind).toBe('invalid');
    expect(detector.observe('BTCUSD', '1m', -3, at(0)).kind).toBe('invalid');
    expect(detector.lastSeq('BTCUSD', '1m')).toBe(-1);
    expect(detector.stats().invalid).toBe(2);
  });

  it('keys state per (symbol, timeframe) — one gap never taints a sibling', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 1, at(0));
    detector.observe('BTCUSD', '5m', 1, at(0));
    detector.observe('ETHUSD', '1m', 1, at(0));

    detector.observe('BTCUSD', '1m', 9, at(1));

    expect(detector.isStale('BTCUSD', '1m')).toBe(true);
    expect(detector.isStale('BTCUSD', '5m')).toBe(false);
    expect(detector.isStale('ETHUSD', '1m')).toBe(false);
    expect(detector.stats().stale).toBe(1);
  });
});

describe('gapDetector — the stale transition', () => {
  it('reports the hole, the backfill cursor, and marks the series stale', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 100, at(0));
    detector.observe('BTCUSD', '1m', 101, at(1));

    const verdict = detector.observe('BTCUSD', '1m', 105, at(5));

    expect(verdict.kind).toBe('gap');
    if (verdict.kind !== 'gap') return;
    expect(verdict.missing).toBe(3); // 102, 103, 104
    expect(verdict.lastSeq).toBe(101);
    // Backfill starts at the last bar we can still trust.
    expect(verdict.backfillFrom).toBe(at(1));
    expect(detector.isStale('BTCUSD', '1m')).toBe(true);
    // The frame in hand is still real data, so the baseline moves forward.
    expect(detector.lastSeq('BTCUSD', '1m')).toBe(105);
  });

  it('stays stale while the stream keeps flowing in order — only reconcile clears it', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 1, at(0));
    detector.observe('BTCUSD', '1m', 5, at(4));

    expect(detector.isStale('BTCUSD', '1m')).toBe(true);
    detector.observe('BTCUSD', '1m', 6, at(5));
    detector.observe('BTCUSD', '1m', 7, at(6));
    expect(detector.isStale('BTCUSD', '1m')).toBe(true);

    detector.reconcile('BTCUSD', '1m');
    expect(detector.isStale('BTCUSD', '1m')).toBe(false);
    expect(detector.stats().stale).toBe(0);
  });

  it('re-arms after a second gap following a reconcile', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 1, at(0));
    detector.observe('BTCUSD', '1m', 4, at(3));
    detector.reconcile('BTCUSD', '1m');
    detector.observe('BTCUSD', '1m', 9, at(8));

    expect(detector.isStale('BTCUSD', '1m')).toBe(true);
    expect(detector.stats().gaps).toBe(2);
  });

  it('forgets a key on reset, so a restarted seq is not read as a gap', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 9_000, at(0));
    detector.reset('BTCUSD', '1m');

    expect(detector.lastSeq('BTCUSD', '1m')).toBe(-1);
    expect(detector.observe('BTCUSD', '1m', 1, at(1)).kind).toBe('first');
    expect(detector.isStale('BTCUSD', '1m')).toBe(false);
  });

  it('resetAll clears every key', () => {
    const detector = createGapDetector();
    detector.observe('BTCUSD', '1m', 1, at(0));
    detector.observe('ETHUSD', '1m', 1, at(0));
    detector.resetAll();

    expect(detector.lastSeq('BTCUSD', '1m')).toBe(-1);
    expect(detector.lastSeq('ETHUSD', '1m')).toBe(-1);
    expect(detector.lastGoodTime('ETHUSD', '1m')).toBeNull();
  });
});
