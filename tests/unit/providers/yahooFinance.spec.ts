/**
 * Yahoo Finance.
 *
 * The fixtures are trimmed from live responses, not invented, because every property worth
 * holding here is a property of Yahoo's actual output: the trailing row that is a quote
 * rather than a bar, the `null` holes at untraded minutes, the epoch-seconds stamps, and
 * the range table that `meta.validRanges` gets wrong.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyYahooError,
  createYahooProvider,
  parseChart,
  rangeFor,
  YAHOO_PROXY,
} from '../../../src/providers/yahooFinance.js';
import type { HttpGet } from '../../../src/providers/types.js';
import type { Timeframe } from '../../../src/data/types.js';

/** 09:30, 09:31 and 09:32 New York on 2026-08-14, as epoch seconds. */
const OPEN = 1786714200;

/**
 * A minute series in Yahoo's shape: three real bars, one untraded minute, and the live
 * quote row Yahoo appends at `regularMarketTime`.
 */
const MINUTE_CHART = {
  chart: {
    result: [
      {
        meta: {
          currency: 'USD',
          symbol: 'ASML',
          exchangeTimezoneName: 'America/New_York',
          regularMarketTime: 1786727423,
          regularMarketPrice: 1827.58,
          chartPreviousClose: 1800,
          currentTradingPeriod: { regular: { start: 1786714200, end: 1786737600 } },
          validRanges: ['1d', '5d', '1mo', '1y', 'max'],
        },
        timestamp: [OPEN, OPEN + 60, OPEN + 120, OPEN + 180, 1786727423],
        indicators: {
          quote: [
            {
              open: [1834.1, 1843.28, 1840.0, null, 1827.58],
              high: [1845.0, 1844.0, 1841.5, null, 1827.58],
              low: [1833.0, 1839.0, 1838.0, null, 1827.58],
              close: [1843.02, 1839.55, 1840.5, null, 1827.58],
              volume: [51925, 5141, 3300, null, 0],
            },
          ],
        },
      },
    ],
    error: null,
  },
};

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Answers every request with one body, and records the URLs asked for. */
function transport(body: unknown, status = 200): { http: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    http: (url) => {
      urls.push(url);
      return Promise.resolve({
        status,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    },
  };
}

const provider = (body: unknown, status = 200) => {
  const { http, urls } = transport(body, status);
  return { urls, market: createYahooProvider({ ready: true, http, now: () => 1786727500_000 }) };
};

describe('capabilities', () => {
  it('serves every timeframe the app draws, natively', () => {
    // The reason this provider exists. Yahoo is the only free source verified to do it.
    const capabilities = createYahooProvider({ ready: true }).capabilities();
    expect([...capabilities.nativeTimeframes]).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });

  it('is unready when nothing is proxying, so no button claims to work', () => {
    // Without the proxy the route is served by the app's own page. A provider that claimed
    // six timeframes there would enable all six and fail on every press.
    expect(createYahooProvider({ ready: false }).capabilities().ready).toBe(false);
  });

  it('refuses to call out at all when unready', async () => {
    const { http, urls } = transport(MINUTE_CHART);
    const market = createYahooProvider({ ready: false, http });
    const result = await market.fetchSeries('ASML', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('no-key');
    expect(result.reason).toContain('proxy');
    expect(urls).toHaveLength(0);
  });
});

describe('parsing a chart', () => {
  it('reads epoch seconds as the bar open, in UTC', () => {
    // 13:30:00Z is 09:30 New York. Yahoo stamps in UTC already, so unlike Twelve Data
    // there is no zone conversion here — and a stray one would move every bar.
    const page = parseChart(clone(MINUTE_CHART).chart.result[0]);
    expect(page.bars[0].t).toBe(OPEN * 1000);
    expect(new Date(page.bars[0].t).toISOString()).toBe('2026-08-14T13:30:00.000Z');
  });

  it('drops the live-quote row Yahoo appends after the last bar', () => {
    // It is stamped with a precise trade time — 17:10:23 — so keeping it puts a bar open
    // at 23 seconds past the minute into a 1-minute series.
    const page = parseChart(clone(MINUTE_CHART).chart.result[0]);
    for (const bar of page.bars) expect(bar.t % 60_000, new Date(bar.t).toISOString()).toBe(0);
    expect(page.bars.map((bar) => bar.t)).not.toContain(1786727423_000);
  });

  it('drops an untraded minute rather than charting a hole as zero', () => {
    const page = parseChart(clone(MINUTE_CHART).chart.result[0]);
    expect(page.bars).toHaveLength(3);
  });

  it('counts every row it dropped', () => {
    // A provider quietly losing rows to a format change looks exactly like a thin market.
    const page = parseChart(clone(MINUTE_CHART).chart.result[0]);
    expect(page.dropped).toBe(2);
  });

  it('keeps a zero-volume bar, because that is a real quiet minute', () => {
    const payload = clone(MINUTE_CHART);
    payload.chart.result[0].indicators.quote[0].volume = [51925, null, 3300, null, 0];
    const page = parseChart(payload.chart.result[0]);
    expect(page.bars).toHaveLength(3);
    expect(page.bars[1].v).toBe(0);
  });

  it('returns frozen, ascending bars', () => {
    const page = parseChart(clone(MINUTE_CHART).chart.result[0]);
    for (const bar of page.bars) expect(Object.isFrozen(bar)).toBe(true);
    for (let i = 1; i < page.bars.length; i++) {
      expect(page.bars[i].t).toBeGreaterThan(page.bars[i - 1].t);
    }
  });

  it('survives a payload with no rows at all', () => {
    expect(parseChart({}).bars).toHaveLength(0);
  });
});

describe('choosing a range', () => {
  it('asks for the smallest range that covers the request', () => {
    expect(rangeFor('1m', 100)).toBe('1d');
    expect(rangeFor('1m', 1000)).toBe('5d');
  });

  it('never asks a 1-minute series for more than Yahoo will give', () => {
    // `meta.validRanges` advertises `1y` and `max` for a 1m series that refuses anything
    // past about eight days — trusting it produces an Unprocessable Entity on every load.
    for (const limit of [1, 500, 5000, 100_000]) {
      expect(['1d', '5d', '7d']).toContain(rangeFor('1m', limit));
    }
  });

  it('has a range for every timeframe it claims to serve', () => {
    for (const timeframe of ['1m', '5m', '15m', '1h', '4h', '1d'] as Timeframe[]) {
      expect(rangeFor(timeframe, 500), timeframe).not.toBe('');
    }
  });
});

describe('fetching', () => {
  it('asks the proxy, not Yahoo directly', async () => {
    // Yahoo sends no CORS header, so a direct call from the page cannot work at all.
    const { market, urls } = provider(MINUTE_CHART);
    await market.fetchSeries('ASML', '1m', 100);
    expect(urls[0].startsWith(YAHOO_PROXY)).toBe(true);
    expect(urls[0]).not.toContain('finance.yahoo.com');
  });

  it('asks for the interval it was given', async () => {
    const { market, urls } = provider(MINUTE_CHART);
    await market.fetchSeries('ASML', '4h', 100);
    expect(urls[0]).toContain('interval=4h');
  });

  it('upper-cases and encodes the symbol', async () => {
    const { market, urls } = provider(MINUTE_CHART);
    await market.fetchSeries('brk.b', '1d', 10);
    expect(urls[0]).toContain('BRK.B');
  });

  it('reports a delisted symbol as not-found', async () => {
    const { market } = provider({
      chart: { result: null, error: { code: 'Not Found', description: 'No data found, symbol may be delisted' } },
    });
    const result = await market.fetchSeries('NOPE', '1d', 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('not-found');
  });

  it('names the missing proxy when the page answers with its own HTML', async () => {
    // The single most likely misconfiguration, and it looks like nothing else: a 200 whose
    // body is the app's own index.html.
    const { market } = provider('<!doctype html><html><body>…</body></html>');
    const result = await market.fetchSeries('ASML', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('proxy');
  });

  it('reports a rate limit as one, so the app keeps retrying later', async () => {
    const { market } = provider('', 429);
    const result = await market.fetchSeries('ASML', '1m', 100);
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('rate-limit');
  });

  it('never throws when the transport does', async () => {
    const market = createYahooProvider({
      ready: true,
      http: () => Promise.reject(new Error('socket hang up')),
    });
    await expect(market.fetchSeries('ASML', '1m', 10)).resolves.toMatchObject({ ok: false });
  });
});

describe('quoting', () => {
  it('reads the live price out of the chart metadata', async () => {
    const { market } = provider(MINUTE_CHART);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.price).toBe(1827.58);
  });

  it('converts the quote time from seconds', async () => {
    // Read as milliseconds it lands in 1970, and the live bar is appended half a century
    // early.
    const { market } = provider(MINUTE_CHART);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.time).toBe(1786727423_000);
  });

  it('carries the previous close, so a change can be computed without more requests', async () => {
    // The number is in every payload and used to be thrown away, which left the percentage
    // derivable only for whichever instrument happened to be on the chart.
    const { market } = provider(MINUTE_CHART);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.previousClose).toBe(1800);
  });

  it('reports no baseline rather than a wrong one when Yahoo omits it', async () => {
    const payload = clone(MINUTE_CHART);
    delete (payload.chart.result[0].meta as { chartPreviousClose?: unknown }).chartPreviousClose;
    const { market } = provider(payload);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.previousClose).toBeNull();
  });

  it('says the market is open when the clock is inside the session', async () => {
    const { market } = provider(MINUTE_CHART);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.marketOpen).toBe(true);
  });

  it('says it is closed once the session has ended', async () => {
    const { http } = transport(MINUTE_CHART);
    // Session ends at 1786737600; this is an hour later.
    const market = createYahooProvider({ ready: true, http, now: () => 1786741200_000 });
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.marketOpen).toBe(false);
  });

  it('says nothing rather than guessing when Yahoo omits the session', async () => {
    const payload = clone(MINUTE_CHART);
    delete (payload.chart.result[0].meta as { currentTradingPeriod?: unknown })
      .currentTradingPeriod;
    const { market } = provider(payload);
    const result = await market.fetchQuote('ASML');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.marketOpen).toBeNull();
  });
});

describe('searching', () => {
  const SEARCH = {
    quotes: [
      { symbol: 'ASML', longname: 'ASML Holding N.V.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
      { symbol: 'ASML.AS', shortname: 'ASML HOLDING', exchDisp: 'Amsterdam', quoteType: 'EQUITY' },
      { symbol: 'SMH', longname: 'VanEck Semiconductor ETF', exchDisp: 'NASDAQ', quoteType: 'ETF' },
      { symbol: 'ES=F', shortname: 'E-Mini S&P', exchDisp: 'CME', quoteType: 'FUTURE' },
    ],
  };

  it('keeps the same company on two venues apart', async () => {
    // ASML in New York and ASML in Amsterdam are different instruments in different
    // currencies.
    const { market } = provider(SEARCH);
    const result = await market.searchSymbols('asml');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.map((hit) => hit.symbol)).toContain('ASML');
    expect(result.value.map((hit) => hit.symbol)).toContain('ASML.AS');
  });

  it('drops instruments this app cannot chart', async () => {
    const { market } = provider(SEARCH);
    const result = await market.searchSymbols('asml');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.map((hit) => hit.symbol)).not.toContain('ES=F');
  });

  it('keeps ETFs, which chart exactly like equities', async () => {
    const { market } = provider(SEARCH);
    const result = await market.searchSymbols('semi');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.map((hit) => hit.symbol)).toContain('SMH');
  });

  it('does not call out for an empty query', async () => {
    const { market, urls } = provider(SEARCH);
    const result = await market.searchSymbols('   ');
    expect(result.ok).toBe(true);
    expect(urls).toHaveLength(0);
  });
});

describe('classifying errors', () => {
  it('reads a bad interval/range pair as this adapter’s own bug', () => {
    // "Only 8 days worth of 1m granularity data are allowed" is not something the reader
    // can fix, so it must not be dressed up as a symbol or entitlement problem.
    const result = classifyYahooError('Unprocessable Entity', '1m data not available for…');
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('format');
  });

  it('reads a delisting as not-found', () => {
    const result = classifyYahooError('Not Found', 'No data found, symbol may be delisted');
    if (result.ok) throw new Error('expected failure');
    expect(result.kind).toBe('not-found');
  });
});
