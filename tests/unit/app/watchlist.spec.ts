/**
 * Watchlist state.
 *
 * The failures worth preventing are all quiet ones: a duplicate row, an entry that comes
 * back after being deleted, a price shown against the wrong name, or a stored list that
 * repopulates itself because "empty" was read as "unset".
 */

import { describe, expect, it } from 'vitest';
import {
  addSymbol,
  applyQuote,
  createWatchlist,
  DEFAULT_WATCHLIST,
  fromStorage,
  removeSymbol,
  rowsOf,
  toStorage,
} from '../../../src/app/watchlist.js';
import type { Quote } from '../../../src/providers/types.js';
import type { TimeMs } from '../../../src/data/types.js';

const quote = (symbol: string, price: number, previousClose: number | null = null): Quote => ({
  symbol,
  price,
  time: 1_700_000_000_000 as TimeMs,
  marketOpen: true,
  previousClose,
});

describe('membership', () => {
  it('starts from a list rather than empty', () => {
    expect(createWatchlist().symbols.length).toBe(DEFAULT_WATCHLIST.length);
  });

  it('adds a symbol at the end', () => {
    // Appending, not prepending: the list is something the reader arranges, and re-adding
    // a symbol must not reorder what they arranged.
    const state = addSymbol(createWatchlist(['AAPL', 'MSFT']), 'PLTR');
    expect([...state.symbols]).toEqual(['AAPL', 'MSFT', 'PLTR']);
  });

  it('never lists the same instrument twice', () => {
    const once = addSymbol(createWatchlist(['AAPL']), 'aapl');
    expect([...once.symbols]).toEqual(['AAPL']);
    expect([...createWatchlist(['AAPL', 'aapl', ' AAPL ']).symbols]).toEqual(['AAPL']);
  });

  it('ignores a blank symbol', () => {
    const state = addSymbol(createWatchlist(['AAPL']), '   ');
    expect([...state.symbols]).toEqual(['AAPL']);
  });

  it('removes a symbol', () => {
    const state = removeSymbol(createWatchlist(['AAPL', 'MSFT']), 'msft');
    expect([...state.symbols]).toEqual(['AAPL']);
  });

  it('leaves the state alone when removing something not listed', () => {
    const before = createWatchlist(['AAPL']);
    expect(removeSymbol(before, 'ZZZZ')).toBe(before);
  });
});

describe('quotes', () => {
  it('records a price against its own symbol', () => {
    const state = applyQuote(createWatchlist(['AAPL', 'MSFT']), quote('AAPL', 190));
    const rows = rowsOf(state, 'AAPL');
    expect(rows[0]).toMatchObject({ symbol: 'AAPL', price: 190 });
    expect(rows[1]).toMatchObject({ symbol: 'MSFT', price: null });
  });

  it('computes change from the baseline the quote itself carries', () => {
    // Every provider sends the previous close. Using it is what gives a percentage for
    // EVERY row rather than only the instrument currently on the chart.
    const state = applyQuote(createWatchlist(['AAPL']), quote('AAPL', 110, 100));
    expect(rowsOf(state, '')[0].change).toBeCloseTo(0.1, 6);
  });

  it('lets an explicit baseline win over the quote’s own', () => {
    const state = applyQuote(createWatchlist(['AAPL']), quote('AAPL', 110, 55), 100);
    expect(rowsOf(state, '')[0].change).toBeCloseTo(0.1, 6);
  });

  it('keeps the last known change when no previous close is supplied', () => {
    // The quote endpoint is polled far more often than the daily bar that gives the
    // baseline; dropping the change on every tick would make the column flicker to blank.
    let state = applyQuote(createWatchlist(['AAPL']), quote('AAPL', 110, 100));
    state = applyQuote(state, quote('AAPL', 111));
    const row = rowsOf(state, '')[0];
    expect(row.price).toBe(111);
    expect(row.change).toBeCloseTo(0.1, 6);
  });

  it('ignores a quote for a symbol that is not listed', () => {
    // Requests are in flight while the list is edited. A late answer must not resurrect a
    // row the reader deleted.
    const before = createWatchlist(['AAPL']);
    expect(applyQuote(before, quote('MSFT', 400))).toBe(before);
  });

  it('drops the quote when the symbol is removed', () => {
    // Otherwise a re-added symbol renders with a stale price that looks freshly fetched.
    let state = applyQuote(createWatchlist(['AAPL']), quote('AAPL', 190));
    state = removeSymbol(state, 'AAPL');
    state = addSymbol(state, 'AAPL');
    expect(rowsOf(state, '')[0].price).toBeNull();
  });

  for (const [label, price] of [
    ['zero', 0],
    ['negative', -1],
    ['not a number', Number.NaN],
  ] as const) {
    it(`refuses a ${label} price`, () => {
      const before = createWatchlist(['AAPL']);
      expect(applyQuote(before, quote('AAPL', price))).toBe(before);
    });
  }
});

describe('rows', () => {
  it('marks the chart’s symbol as active', () => {
    const rows = rowsOf(createWatchlist(['AAPL', 'MSFT']), 'msft');
    expect(rows.map((row) => row.active)).toEqual([false, true]);
  });

  it('keeps list order', () => {
    const rows = rowsOf(createWatchlist(['TSLA', 'AAPL', 'NVDA']), '');
    expect(rows.map((row) => row.symbol)).toEqual(['TSLA', 'AAPL', 'NVDA']);
  });
});

describe('persistence', () => {
  it('stores membership only, never a price', () => {
    // A stored price is wrong the moment it is read back.
    const state = applyQuote(createWatchlist(['AAPL']), quote('AAPL', 190));
    expect(toStorage(state)).toEqual(['AAPL']);
  });

  it('round-trips', () => {
    const state = createWatchlist(['TSLA', 'AAPL']);
    expect([...fromStorage(toStorage(state)).symbols]).toEqual(['TSLA', 'AAPL']);
  });

  it('restores an EMPTY list as empty, not as the defaults', () => {
    // Removing every symbol is a real choice, and "empty" must not be read as "unset".
    expect(fromStorage([]).symbols).toHaveLength(0);
  });

  it('falls back to the defaults when the stored value is not a list', () => {
    for (const bad of [null, undefined, 'AAPL', 42, { symbols: ['AAPL'] }]) {
      expect(fromStorage(bad).symbols.length).toBe(DEFAULT_WATCHLIST.length);
    }
  });

  it('drops non-string entries rather than rendering them', () => {
    expect([...fromStorage(['AAPL', 7, null, 'MSFT']).symbols]).toEqual(['AAPL', 'MSFT']);
  });
});
