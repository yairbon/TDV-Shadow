import { describe, expect, it } from 'vitest';
import { createBarPipeline } from '../../../src/data/pipeline.js';
import { createSeriesStore } from '../../../src/data/store/seriesStore.js';
import type { SeriesStore } from '../../../src/data/store/seriesStore.js';
import type { HistoryQuery, HistoryTransport } from '../../../src/data/rest/history.js';
import type { BarEvent } from '../../../src/data/ws/client.js';
import type { Timeframe } from '../../../src/data/types.js';
import { bar, MINUTE, T0 } from './_helpers.js';

const event = (seq: number, index: number, close = 105): BarEvent => ({
  symbol: 'BTCUSD',
  tf: '1m',
  seq,
  final: false,
  bar: bar(T0 + index * MINUTE, 100, 200, 50, close, 1),
});

function fixture(transport?: HistoryTransport): {
  readonly store: SeriesStore;
  readonly pipeline: ReturnType<typeof createBarPipeline>;
  readonly errors: unknown[];
} {
  const store = createSeriesStore({ symbol: 'BTCUSD', tf: '1m', state: 'loading' });
  const errors: unknown[] = [];
  const resolve = (symbol: string, tf: Timeframe): SeriesStore | null =>
    symbol === 'BTCUSD' && tf === '1m' ? store : null;

  const pipeline = createBarPipeline({
    resolve,
    onBackfillError: (error) => errors.push(error),
    ...(transport === undefined ? {} : { transport }),
  });

  return { store, pipeline, errors };
}

describe('pipeline — the happy path', () => {
  it('buffers in-order bars and flips the series live on the first one', () => {
    const { store, pipeline } = fixture();

    pipeline.handleBar(event(1, 0));
    expect(store.get().state).toBe('live');
    expect(store.get().bars).toHaveLength(0); // still buffered

    pipeline.handleBar(event(2, 1));
    pipeline.flush();

    expect(store.get().bars.map((b) => b.t)).toEqual([T0, T0 + MINUTE]);
    expect(store.get().lastSeq).toBe(2);
  });

  it('never writes a replayed frame to the store', () => {
    const { store, pipeline } = fixture();
    pipeline.handleBar(event(1, 0));
    pipeline.flush();
    const revision = store.revision();

    pipeline.handleBar(event(1, 0));
    pipeline.flush();

    expect(store.revision()).toBe(revision);
    expect(pipeline.stats().duplicates).toBe(1);
  });
});

describe('pipeline — a sequence gap marks the series stale and backfills it', () => {
  it('marks stale immediately, fetches [lastGood, now], merges and reconciles', async () => {
    const queries: HistoryQuery[] = [];
    const transport: HistoryTransport = (query) => {
      queries.push(query);
      // Descending, as the server sends it: the two bars the gap swallowed.
      return Promise.resolve({
        bars: [
          [T0 + 3 * MINUTE, 100, 200, 50, 103, 1],
          [T0 + 2 * MINUTE, 100, 200, 50, 102, 1],
          [T0 + MINUTE, 100, 200, 50, 101, 1],
        ],
      });
    };

    const { store, pipeline } = fixture(transport);
    pipeline.handleBar(event(1, 0));
    pipeline.flush();

    pipeline.handleBar(event(4, 3)); // seq 2 and 3 never arrived

    expect(store.get().state).toBe('stale');
    expect(pipeline.stats().gaps).toBe(1);
    expect(pipeline.gaps().stale).toBe(1);

    await pipeline.settled();
    pipeline.flush();

    expect(queries[0].to).toBe(T0 + 3 * MINUTE);
    expect(store.get().bars.map((b) => b.t)).toEqual([
      T0,
      T0 + MINUTE,
      T0 + 2 * MINUTE,
      T0 + 3 * MINUTE,
    ]);
    expect(store.get().state).toBe('live');
    expect(pipeline.gaps().stale).toBe(0);
    expect(pipeline.stats().reconciled).toBe(1);
  });

  it('never interpolates: a failed backfill leaves the hole and the stale flag', async () => {
    const transport: HistoryTransport = () => Promise.reject(new Error('gateway 503'));
    const { store, pipeline, errors } = fixture(transport);

    pipeline.handleBar(event(1, 0));
    pipeline.handleBar(event(9, 8));
    await pipeline.settled();
    pipeline.flush();

    expect(store.get().state).toBe('stale');
    expect(store.get().bars.map((b) => b.t)).toEqual([T0, T0 + 8 * MINUTE]);
    expect(errors).toHaveLength(1);
    expect(pipeline.stats().backfillFailures).toBe(1);
  });

  it('folds a second gap into the running recovery instead of stacking fetches', async () => {
    let active = 0;
    let maxActive = 0;
    const windows: (readonly [number | null, number])[] = [];
    const transport: HistoryTransport = async (query) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      windows.push([query.to, query.limit]);
      await Promise.resolve();
      active -= 1;
      return { bars: [] };
    };
    const { store, pipeline } = fixture(transport);

    pipeline.handleBar(event(1, 0));
    pipeline.handleBar(event(5, 4));
    pipeline.handleBar(event(20, 19)); // second gap while the first is in flight

    await pipeline.settled();

    expect(maxActive).toBe(1);
    expect(pipeline.stats().backfills).toBe(2);
    // The series only leaves `stale` once the queue has actually drained.
    expect(store.get().state).toBe('live');
    expect(pipeline.stats().reconciled).toBe(1);
    expect(windows[windows.length - 1][0]).toBe(T0 + 19 * MINUTE);
  });

  it('stays stale forever when no REST transport is wired — no lying', () => {
    const { store, pipeline } = fixture();

    pipeline.handleBar(event(1, 0));
    pipeline.handleBar(event(7, 6));
    pipeline.flush();

    expect(store.get().state).toBe('stale');
    expect(pipeline.stats().backfills).toBe(0);
    expect(store.get().bars).toHaveLength(2);
  });

  it('reset() lets a resubscribed stream restart its sequence', () => {
    const { pipeline } = fixture();
    pipeline.handleBar(event(900, 0));
    pipeline.reset('BTCUSD', '1m');
    pipeline.handleBar(event(1, 1));

    expect(pipeline.stats().gaps).toBe(0);
    expect(pipeline.gaps().stale).toBe(0);
  });
});
