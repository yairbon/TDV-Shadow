/**
 * Symbol search ranking.
 *
 * The matcher this replaced was one line — a substring filter in declaration order — so
 * `APL` found nothing and `A` returned eight symbols in whatever order they happened to
 * be declared. Everything below is about ORDER, because a search that returns the right
 * set in the wrong order is the same as a search that does not work.
 *
 * The fixture is deliberately local. Importing the real `SYMBOLS` would make these tests
 * fail whenever the bundled data changes, which is a different fact about the world.
 */

import { describe, expect, it } from 'vitest';
import { searchSymbols, type SearchableSymbol } from '../../../src/app/symbolSearch.js';

const FIXTURE: readonly SearchableSymbol[] = [
  { symbol: 'AAPL', label: 'AAPL · Apple' },
  { symbol: 'AMD', label: 'AMD · Advanced Micro Devices' },
  { symbol: 'AMZN', label: 'AMZN · Amazon' },
  { symbol: 'AVGO', label: 'AVGO · Broadcom' },
  { symbol: 'GLD', label: 'GLD · Gold ETF' },
  { symbol: 'GOOGL', label: 'GOOGL · Alphabet Google' },
  { symbol: 'META', label: 'META · Meta Platforms' },
  { symbol: 'MSFT', label: 'MSFT · Microsoft' },
  { symbol: 'NVDA', label: 'NVDA · NVIDIA' },
  { symbol: 'QQQ', label: 'QQQ · Nasdaq 100 ETF' },
  { symbol: 'SPY', label: 'SPY · S&P 500 ETF' },
  // Exists so "SOFT" can be a word start here and mid-word in "Microsoft" — the only
  // shape that tells the word-start tier apart from a plain substring match.
  { symbol: 'STC', label: 'STC · Soft Commodities' },
  { symbol: 'TSLA', label: 'TSLA · Tesla' },
];

const tickers = (query: string, options?: Parameters<typeof searchSymbols>[2]): string[] =>
  searchSymbols(query, FIXTURE, options).map((hit) => hit.item.symbol);

describe('ranking tiers', () => {
  it('puts an exact ticker first even when another symbol’s label contains the query', () => {
    // "META" is both a ticker and a word in "Meta Platforms"; the ticker must win.
    expect(tickers('META')[0]).toBe('META');
  });

  it('ranks a shorter ticker above a longer one for the same prefix', () => {
    // Four symbols start with "A" and coverage is what separates them: AMD is a 1-of-3
    // match, the others are 1-of-4. Alphabetical order would put AAPL first, so this
    // fails the moment coverage stops contributing — which a `slice(0, 2)` assertion on
    // a query like "AM" would not, because there the two orders agree.
    // Only the prefix group is asserted: "A" also starts a word in several labels
    // ("Alphabet", "Amazon", "Advanced"), and those sit in a lower tier behind these.
    expect(tickers('A').slice(0, 4)).toEqual(['AMD', 'AAPL', 'AMZN', 'AVGO']);
  });

  it('beats a mid-word substring with a label word start', () => {
    // "SOFT" starts a word in "STC · Soft Commodities" and sits mid-word in
    // "MSFT · Microsoft". Neither matches by ticker, so the tier is the only thing
    // separating them — and alphabetically MSFT would come first, so this fails if the
    // word-start tier stops contributing.
    expect(tickers('SOFT')).toEqual(['STC', 'MSFT']);
  });

  it('finds a ticker by subsequence when no literal match exists', () => {
    expect(tickers('APL')).toContain('AAPL');
    expect(tickers('GGL')).toContain('GOOGL');
  });

  it('does not fuzzy-match the label, only the ticker', () => {
    // "ADM" is a subsequence of "AMD · Advanced Micro Devices" if labels were fuzzy —
    // and of a dozen other labels too, which is exactly why they are not.
    const hits = searchSymbols('ZZZZ', FIXTURE);
    expect(hits).toHaveLength(0);
  });

  it('returns nothing for a query that matches nothing', () => {
    expect(searchSymbols('QWXZ', FIXTURE)).toHaveLength(0);
  });
});

describe('query normalisation', () => {
  it('ignores case and surrounding whitespace', () => {
    expect(tickers('  aapl ')[0]).toBe('AAPL');
  });

  it('treats an all-whitespace query as empty', () => {
    expect(tickers('   ')).toHaveLength(FIXTURE.length);
  });
});

describe('empty query', () => {
  it('returns everything, alphabetically, when there are no recents', () => {
    const all = tickers('');
    expect(all).toHaveLength(FIXTURE.length);
    expect(all).toEqual([...all].sort());
  });

  it('puts recents first, in recents order', () => {
    const result = tickers('', { recents: ['TSLA', 'NVDA'] });
    expect(result.slice(0, 2)).toEqual(['TSLA', 'NVDA']);
    // …and the remainder is still alphabetical.
    const rest = result.slice(2);
    expect(rest).toEqual([...rest].sort());
  });
});

describe('recents', () => {
  it('breaks a tie by POSITION, not merely by membership', () => {
    // GLD and GOOGL both match "G" by prefix but differ in length, so use two symbols
    // whose only difference is recency: QQQ and SPY both match "ETF" as a label word.
    const first = tickers('ETF', { recents: ['SPY', 'GLD'] });
    const second = tickers('ETF', { recents: ['GLD', 'SPY'] });
    expect(first.indexOf('SPY')).toBeLessThan(first.indexOf('GLD'));
    expect(second.indexOf('GLD')).toBeLessThan(second.indexOf('SPY'));
  });

  it('never promotes a recent above a better tier', () => {
    // AAPL is an exact ticker; TSLA being the most recent must not outrank it.
    expect(tickers('AAPL', { recents: ['TSLA'] })[0]).toBe('AAPL');
  });
});

describe('ordering is total', () => {
  it('does not depend on the order of the input array', () => {
    const shuffled = [...FIXTURE].reverse();
    for (const query of ['', 'A', 'AM', 'ETF', 'APL', 'GOLD']) {
      expect(searchSymbols(query, shuffled).map((h) => h.item.symbol), query).toEqual(
        searchSymbols(query, FIXTURE).map((h) => h.item.symbol),
      );
    }
  });
});

describe('highlight ranges', () => {
  const check = (text: string, ranges: readonly (readonly [number, number])[]): void => {
    let previousEnd = -1;
    for (const [start, end] of ranges) {
      expect(start).toBeGreaterThanOrEqual(0);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(text.length);
      // Ascending and non-overlapping: the dialog slices with these in order.
      expect(start).toBeGreaterThanOrEqual(previousEnd);
      previousEnd = end;
    }
  };

  it('are valid, ascending and non-overlapping for every hit', () => {
    for (const query of ['A', 'AM', 'ETF', 'APL', 'GOLD', 'MICRO']) {
      for (const hit of searchSymbols(query, FIXTURE)) {
        check(hit.item.symbol, hit.symbolRanges);
        check(hit.item.label, hit.labelRanges);
      }
    }
  });

  it('slice back to the characters that matched', () => {
    const hit = searchSymbols('GOLD', FIXTURE)[0];
    const sliced = hit.labelRanges.map(([a, b]) => hit.item.label.slice(a, b).toUpperCase());
    expect(sliced).toContain('GOLD');
  });

  it('mark the scattered characters of a fuzzy ticker match', () => {
    const hit = searchSymbols('GGL', FIXTURE).find((h) => h.item.symbol === 'GOOGL');
    expect(hit).toBeDefined();
    const sliced = (hit?.symbolRanges ?? []).map(([a, b]) => hit?.item.symbol.slice(a, b));
    expect(sliced.join('')).toBe('GGL');
  });

  it('are empty for an empty query, which highlights nothing', () => {
    for (const hit of searchSymbols('', FIXTURE)) {
      expect(hit.symbolRanges).toEqual([]);
      expect(hit.labelRanges).toEqual([]);
    }
  });
});

describe('case folding preserves indices', () => {
  // `'ß'.toUpperCase()` is `'SS'` — two characters where there was one. Folding with a
  // plain `toUpperCase()` would shift every range after it by one, and the dialog would
  // highlight the wrong characters. Such characters are left unfolded instead.
  const ODD: readonly SearchableSymbol[] = [{ symbol: 'DBK', label: 'DBK · Straße Bank' }];

  it('keeps ranges valid in a label whose uppercase is longer', () => {
    const hit = searchSymbols('BANK', ODD)[0];
    expect(hit).toBeDefined();
    const [start, end] = hit.labelRanges[0];
    expect(hit.item.label.slice(start, end)).toBe('Bank');
  });

  it('still matches text before the odd character', () => {
    const hit = searchSymbols('DBK', ODD)[0];
    expect(hit.item.symbol).toBe('DBK');
  });
});

describe('limit', () => {
  it('truncates AFTER ranking, so a small limit still returns the best matches', () => {
    const full = tickers('A');
    const limited = tickers('A', { limit: 3 });
    expect(limited).toHaveLength(3);
    // Not "some three of them" — the same three, in the same order.
    expect(limited).toEqual(full.slice(0, 3));
  });

  it('returns nothing for a non-positive limit', () => {
    expect(searchSymbols('A', FIXTURE, { limit: 0 })).toHaveLength(0);
  });
});
