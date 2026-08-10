import { describe, expect, it } from 'vitest';
import {
  clampLimit,
  fetchHistory,
  fetchHistoryPage,
  historyPath,
  HISTORY_MAX_LIMIT,
} from '../../../src/data/rest/history.js';
import type { HistoryQuery, HistoryTransport } from '../../../src/data/rest/history.js';
import { asTimeMs } from '../../../src/data/types.js';
import { MINUTE, T0 } from './_helpers.js';

/** Descending page, exactly as the server sends it (§3.3). */
const descendingRows = (newestIndex: number, count: number): readonly (readonly number[])[] => {
  const rows: (readonly number[])[] = [];
  for (let i = 0; i < count; i += 1) {
    const index = newestIndex - i;
    rows.push([T0 + index * MINUTE, 100, 5_000, 50, 100 + index, 1]);
  }
  return rows;
};

/** A server holding `total` 1m bars ending at index `newest`. */
function scriptedServer(
  newest: number,
  total: number,
): { readonly transport: HistoryTransport; readonly queries: HistoryQuery[] } {
  const queries: HistoryQuery[] = [];
  const oldest = newest - total + 1;

  const transport: HistoryTransport = (query) => {
    queries.push(query);
    const top = query.to === null ? newest : Math.floor((query.to - T0) / MINUTE);
    const available = Math.max(0, Math.min(query.limit, top - oldest + 1));
    return Promise.resolve({ bars: descendingRows(top, available) });
  };

  return { transport, queries };
}

describe('history — request shaping', () => {
  it('clamps limit to the §3.3 ceiling', () => {
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(1.9)).toBe(1);
    expect(clampLimit(999)).toBe(999);
    expect(clampLimit(50_000)).toBe(HISTORY_MAX_LIMIT);
    expect(clampLimit(Number.NaN)).toBeGreaterThan(0);
  });

  it('builds the documented path and omits `to` when asking for the latest page', () => {
    expect(historyPath({ sym: 'BTCUSD', tf: '1m', to: asTimeMs(T0), limit: 500 })).toBe(
      `/history?sym=BTCUSD&tf=1m&to=${String(T0)}&limit=500`,
    );
    expect(historyPath({ sym: 'BTC/USD', tf: '1h', to: null, limit: 99_999 })).toBe(
      '/history?sym=BTC%2FUSD&tf=1h&limit=5000',
    );
  });
});

describe('history — one page', () => {
  it('flips a descending page into ascending bars and reports the oldest ts as cursor', async () => {
    const transport: HistoryTransport = () => Promise.resolve(descendingRows(10, 4));
    const page = await fetchHistoryPage(transport, {
      sym: 'BTCUSD',
      tf: '1m',
      to: null,
      limit: 4,
    });

    expect(page.bars.map((b) => b.t)).toEqual([
      T0 + 7 * MINUTE,
      T0 + 8 * MINUTE,
      T0 + 9 * MINUTE,
      T0 + 10 * MINUTE,
    ]);
    expect(page.cursor).toBe(T0 + 7 * MINUTE);
    expect(page.dropped).toBe(0);
  });

  it('accepts a { bars: [...] } envelope as well as the bare array above', async () => {
    const transport: HistoryTransport = () => Promise.resolve({ bars: descendingRows(2, 2) });
    const page = await fetchHistoryPage(transport, { sym: 'BTCUSD', tf: '1m', to: null, limit: 2 });
    expect(page.bars).toHaveLength(2);
  });

  it('drops malformed rows and keeps the rest of the page', async () => {
    const transport: HistoryTransport = () =>
      Promise.resolve([
        [T0 + MINUTE, 100, 110, 90, 105, 1],
        [T0, 100, 104, 90, 105, 1], // high < close
        'junk',
      ]);
    const page = await fetchHistoryPage(transport, { sym: 'BTCUSD', tf: '1m', to: null, limit: 3 });

    expect(page.bars).toHaveLength(1);
    expect(page.dropped).toBe(2);
    expect(page.cursor).toBe(T0 + MINUTE);
  });

  it('clamps the limit it hands the transport', async () => {
    const seen: number[] = [];
    const transport: HistoryTransport = (query) => {
      seen.push(query.limit);
      return Promise.resolve([]);
    };
    await fetchHistoryPage(transport, { sym: 'BTCUSD', tf: '1m', to: null, limit: 10_000 });
    expect(seen).toEqual([HISTORY_MAX_LIMIT]);
  });
});

describe('history — paging', () => {
  it('walks descending pages and merges them ascending without duplicates', async () => {
    const { transport, queries } = scriptedServer(999, 1_000);
    const result = await fetchHistory(transport, { sym: 'BTCUSD', tf: '1m', pageLimit: 400 });

    expect(result.pages).toBe(3);
    expect(result.bars).toHaveLength(1_000);
    expect(result.exhausted).toBe(true);

    // Ascending, strictly increasing — the §3.1 invariant the store relies on.
    for (let i = 1; i < result.bars.length; i += 1) {
      expect(result.bars[i].t).toBeGreaterThan(result.bars[i - 1].t);
    }

    // Cursor of page N is the oldest ts of page N-1.
    expect(queries[0].to).toBeNull();
    expect(queries[1].to).toBe(T0 + 600 * MINUTE);
    expect(queries[2].to).toBe(T0 + 201 * MINUTE);
  });

  it('stops at `from` instead of draining the whole server', async () => {
    const { transport } = scriptedServer(999, 1_000);
    const result = await fetchHistory(transport, {
      sym: 'BTCUSD',
      tf: '1m',
      from: asTimeMs(T0 + 900 * MINUTE),
      pageLimit: 50,
    });

    expect(result.bars[0].t).toBe(T0 + 900 * MINUTE);
    expect(result.bars).toHaveLength(100);
    // 3 pages of 50 to cross `from`, not the 20 it would take to drain the server.
    expect(result.pages).toBe(3);
  });

  it('keeps the newest bars when capped by maxBars', async () => {
    const { transport } = scriptedServer(999, 1_000);
    const result = await fetchHistory(transport, {
      sym: 'BTCUSD',
      tf: '1m',
      maxBars: 120,
      pageLimit: 100,
    });

    expect(result.bars).toHaveLength(120);
    expect(result.bars[result.bars.length - 1].t).toBe(T0 + 999 * MINUTE);
  });

  it('gives up on a server whose cursor never moves instead of looping forever', async () => {
    let calls = 0;
    const transport: HistoryTransport = () => {
      calls += 1;
      return Promise.resolve(descendingRows(10, 3)); // same page, every time
    };

    const result = await fetchHistory(transport, { sym: 'BTCUSD', tf: '1m', pageLimit: 3 });

    expect(calls).toBe(2);
    expect(result.bars).toHaveLength(3);
  });

  it('reports exhaustion on an empty first page', async () => {
    const transport: HistoryTransport = () => Promise.resolve({ bars: [] });
    const result = await fetchHistory(transport, { sym: 'BTCUSD', tf: '1m' });

    expect(result.bars).toHaveLength(0);
    expect(result.pages).toBe(1);
    expect(result.exhausted).toBe(true);
  });
});
