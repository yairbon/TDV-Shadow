import { describe, expect, it } from 'vitest';
import { createSeriesStore } from '../../../src/data/store/seriesStore.js';
import type { SeriesStore } from '../../../src/data/store/seriesStore.js';
import { createTickBuffer } from '../../../src/data/store/tickBuffer.js';
import type { Timeframe } from '../../../src/data/types.js';
import { bar, MINUTE, T0 } from './_helpers.js';

function fixture(): {
  readonly store: SeriesStore;
  readonly buffer: ReturnType<typeof createTickBuffer>;
  readonly invalidations: { count: number };
} {
  const store = createSeriesStore({ symbol: 'BTCUSD', tf: '1m', state: 'live' });
  const invalidations = { count: 0 };
  const buffer = createTickBuffer({
    resolve: (symbol: string, tf: Timeframe): SeriesStore | null =>
      symbol === 'BTCUSD' && tf === '1m' ? store : null,
    onPending: () => {
      invalidations.count += 1;
    },
  });
  return { store, buffer, invalidations };
}

const tick = (t: number, seq: number, close: number) => ({
  symbol: 'BTCUSD',
  tf: '1m' as Timeframe,
  bar: bar(t, 100, 1_000, 50, close, 1),
  seq,
  final: false,
});

describe('tickBuffer — back-pressure (ARCHITECTURE.md §2)', () => {
  it('collapses a burst on one bar into a single store write per frame', () => {
    const { store, buffer } = fixture();
    store.append(bar(T0, 100, 200, 50, 100, 1));
    const revisionBefore = store.revision();

    for (let i = 1; i <= 50; i += 1) buffer.push(tick(T0, i, 100 + i));

    expect(buffer.pending()).toBe(1);
    expect(store.revision()).toBe(revisionBefore); // nothing reached the store yet

    const stats = buffer.flush();

    expect(stats.replaced).toBe(1);
    expect(stats.applied).toBe(1);
    expect(store.revision()).toBe(revisionBefore + 1);
    expect(store.get().bars).toHaveLength(1);
    expect(store.get().bars[0].c).toBe(150); // the last value of the burst wins
    expect(store.get().lastSeq).toBe(50);
    expect(buffer.coalesced()).toBe(49);
  });

  it('keeps the closed bar when a burst crosses a bar boundary', () => {
    const { store, buffer } = fixture();

    buffer.push(tick(T0, 1, 101));
    buffer.push(tick(T0, 2, 102));
    buffer.push(tick(T0 + MINUTE, 3, 200));
    buffer.push(tick(T0 + MINUTE, 4, 201));

    expect(buffer.pending()).toBe(2);
    const stats = buffer.flush();

    expect(stats.appended).toBe(2);
    expect(store.get().bars.map((b) => b.c)).toEqual([102, 201]);
  });

  it('applies bars oldest first even if the ticks arrive out of order', () => {
    const { store, buffer } = fixture();

    buffer.push(tick(T0 + MINUTE, 2, 200));
    buffer.push(tick(T0, 1, 100));

    buffer.flush();
    expect(store.get().bars.map((b) => b.t)).toEqual([T0, T0 + MINUTE]);
  });

  it('asks for exactly one invalidation per drained batch, not one per tick', () => {
    const { buffer, invalidations } = fixture();

    for (let i = 0; i < 20; i += 1) buffer.push(tick(T0, i, 100 + i));
    expect(invalidations.count).toBe(1);

    buffer.flush();
    buffer.push(tick(T0, 99, 199));
    expect(invalidations.count).toBe(2);
  });

  it('drops ticks for an unknown series instead of throwing', () => {
    const { buffer } = fixture();
    buffer.push({ ...tick(T0, 1, 101), symbol: 'DOGEUSD' });

    const stats = buffer.flush();
    expect(stats.unrouted).toBe(1);
    expect(stats.applied).toBe(0);
  });

  it('flushing an empty buffer is free and reports nothing', () => {
    const { buffer, store } = fixture();
    const stats = buffer.flush();

    expect(stats.applied).toBe(0);
    expect(store.revision()).toBe(0);
  });

  it('counts an identical repeated tick as unchanged — no revision, no repaint', () => {
    const { store, buffer } = fixture();
    store.append(bar(T0, 100, 200, 50, 105, 1));
    const revision = store.revision();

    buffer.push({ ...tick(T0, 1, 105), bar: bar(T0, 100, 200, 50, 105, 1) });
    const stats = buffer.flush();

    expect(stats.unchanged).toBe(1);
    expect(stats.applied).toBe(0);
    expect(store.revision()).toBe(revision);
  });

  it('clear() abandons pending ticks', () => {
    const { buffer, store } = fixture();
    buffer.push(tick(T0, 1, 101));
    buffer.clear();

    expect(buffer.pending()).toBe(0);
    expect(buffer.flush().applied).toBe(0);
    expect(store.get().bars).toHaveLength(0);
  });
});
