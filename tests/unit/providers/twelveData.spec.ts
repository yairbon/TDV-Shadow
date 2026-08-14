/**
 * The Twelve Data adapter, against its real wire shapes.
 *
 * Every fixture below is a trimmed copy of an actual response observed from the live API,
 * not an invention — including the error body, which arrives with `status: "error"` inside
 * an HTTP 200 and would otherwise be parsed as a successful empty series.
 *
 * The transport is injected, so none of this touches the network.
 */

import { describe, expect, it } from 'vitest';
import { createTwelveDataProvider } from '../../../src/providers/twelveData.js';
import type { HttpGet } from '../../../src/providers/types.js';

/** Observed 2026-08-13: newest-first values, exchange-local datetimes, string numbers. */
const SERIES_BODY = JSON.stringify({
  meta: {
    symbol: 'AAPL',
    interval: '1min',
    currency: 'USD',
    exchange_timezone: 'America/New_York',
    exchange: 'NASDAQ',
    type: 'Common Stock',
  },
  values: [
    { datetime: '2026-08-13 15:59:00', open: '305.1', high: '305.4', low: '305.0', close: '305.26', volume: '120000' },
    { datetime: '2026-08-13 15:58:00', open: '304.9', high: '305.2', low: '304.8', close: '305.1', volume: '98000' },
    { datetime: '2026-08-13 15:57:00', open: '304.7', high: '305.0', low: '304.6', close: '304.9', volume: '87000' },
  ],
  status: 'ok',
});

/** Observed: the demo key refusing a symbol it does not serve. HTTP 200, error in body. */
const REFUSAL_BODY = JSON.stringify({
  code: 401,
  message: "The 'demo' API key is only used for initial familiarity.",
  status: 'error',
});

const SEARCH_BODY = JSON.stringify({
  data: [
    {
      symbol: 'TSLA',
      instrument_name: 'Tesla, Inc.',
      exchange: 'NASDAQ',
      country: 'United States',
      currency: 'USD',
    },
    {
      symbol: 'TSLA',
      instrument_name: 'Tesla, Inc.',
      exchange: 'BMV',
      country: 'Mexico',
      currency: 'MXN',
    },
  ],
});

const QUOTE_BODY = JSON.stringify({
  symbol: 'AAPL',
  exchange: 'NASDAQ',
  datetime: '2026-08-13',
  timestamp: 1786627800,
  close: '305.26001',
  volume: '38492546',
  is_market_open: false,
});

/** A transport that answers every URL with one body, and records what it was asked. */
function scripted(body: string, status = 200): { http: HttpGet; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    http: (url) => {
      urls.push(url);
      return Promise.resolve({ status, body });
    },
  };
}

describe('capabilities', () => {
  it('claims all six timeframes natively', () => {
    // The reason this provider exists. If this ever shrinks, the timeframe buttons shrink
    // with it rather than offering something that cannot be fetched.
    const caps = createTwelveDataProvider().capabilities();
    expect([...caps.nativeTimeframes].sort()).toEqual(['15m', '1d', '1h', '1m', '4h', '5m']);
    expect(caps.canSearch).toBe(true);
    expect(caps.canQuote).toBe(true);
    expect(caps.ready).toBe(true);
  });
});

describe('fetching a series', () => {
  it('returns ascending bars from a newest-first body', async () => {
    // The wire order is reversed. Passed through as-is, every later stage rejects the
    // series for going backwards — and the chart is simply empty with no error anywhere.
    const { http } = scripted(SERIES_BODY);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const { bars } = result.value;
    expect(bars).toHaveLength(3);
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
    // Oldest first: 15:57 leads.
    expect(bars[0].c).toBeCloseTo(304.9, 6);
    expect(bars[2].c).toBeCloseTo(305.26, 6);
  });

  it('converts exchange-local timestamps to UTC', async () => {
    // 15:57 in New York on 2026-08-13 is EDT, so 19:57 UTC. Reading the digits as UTC
    // would put every intraday bar four hours out and still draw a plausible chart.
    const { http } = scripted(SERIES_BODY);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars[0].t).toBe(Date.UTC(2026, 7, 13, 19, 57, 0));
  });

  it('parses the string numbers the API sends', async () => {
    const { http } = scripted(SERIES_BODY);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    const bar = result.value.bars[2];
    expect(bar.o).toBeCloseTo(305.1, 6);
    expect(bar.h).toBeCloseTo(305.4, 6);
    expect(bar.l).toBeCloseTo(305.0, 6);
    expect(bar.v).toBe(120000);
  });

  it('freezes every bar (mandate #4)', async () => {
    const { http } = scripted(SERIES_BODY);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    for (const bar of result.value.bars) expect(Object.isFrozen(bar)).toBe(true);
  });

  it('asks for the interval the timeframe maps to', async () => {
    const { http, urls } = scripted(SERIES_BODY);
    const provider = createTwelveDataProvider({ http, apiKey: 'k' });
    await provider.fetchSeries('AAPL', '1h', 50);
    expect(urls[0]).toContain('interval=1h');
    await provider.fetchSeries('AAPL', '1d', 50);
    expect(urls[1]).toContain('interval=1day');
    await provider.fetchSeries('AAPL', '5m', 50);
    expect(urls[2]).toContain('interval=5min');
  });

  it('reads an error out of a 200 body instead of trusting the status', async () => {
    // The trap this provider shares with Alpha Vantage: HTTP 200 is not evidence of data.
    const { http } = scripted(REFUSAL_BODY, 200);
    const result = await createTwelveDataProvider({ http }).fetchSeries('MSFT', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // An entitlement wall, not a rate limit: the caller must stop offering it, not retry.
    expect(result.kind).toBe('entitlement');
    expect(result.reason).toContain('demo');
  });

  it('separates a rate limit from an entitlement wall', async () => {
    const limited = JSON.stringify({ code: 429, message: 'too many requests', status: 'error' });
    const { http } = scripted(limited);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate-limit');
  });

  it('counts rows it could not parse rather than dropping them silently', async () => {
    const mixed = JSON.stringify({
      meta: { exchange_timezone: 'America/New_York' },
      values: [
        { datetime: '2026-08-13 15:59:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
        { datetime: 'not a date', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
        // high below the open: makeBar rejects it as an impossible bar.
        { datetime: '2026-08-13 15:57:00', open: '9', high: '2', low: '0.5', close: '1.5', volume: '10' },
      ],
    });
    const { http } = scripted(mixed);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars).toHaveLength(1);
    expect(result.value.dropped).toBe(2);
  });

  it('drops a duplicate timestamp rather than breaking the ascending invariant', async () => {
    const repeated = JSON.stringify({
      meta: { exchange_timezone: 'UTC' },
      values: [
        { datetime: '2026-08-13 15:59:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '10' },
        { datetime: '2026-08-13 15:59:00', open: '1', high: '2', low: '0.5', close: '1.4', volume: '10' },
      ],
    });
    const { http } = scripted(repeated);
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars).toHaveLength(1);
    expect(result.value.dropped).toBe(1);
  });

  it('treats a missing volume as zero rather than as an invalid bar', async () => {
    // FX instruments carry no volume. The series is still real.
    const noVolume = JSON.stringify({
      meta: { exchange_timezone: 'UTC' },
      values: [{ datetime: '2026-08-13 15:59:00', open: '1', high: '2', low: '0.5', close: '1.5' }],
    });
    const { http } = scripted(noVolume);
    const result = await createTwelveDataProvider({ http }).fetchSeries('EUR/USD', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars).toHaveLength(1);
    expect(result.value.bars[0].v).toBe(0);
  });

  it('falls back to UTC when no exchange zone is given', async () => {
    const noZone = JSON.stringify({
      meta: {},
      values: [{ datetime: '2026-08-13 15:59:00', open: '1', high: '2', low: '0.5', close: '1.5', volume: '1' }],
    });
    const { http } = scripted(noZone);
    const result = await createTwelveDataProvider({ http }).fetchSeries('X', '1m', 100);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars[0].t).toBe(Date.UTC(2026, 7, 13, 15, 59, 0));
  });

  it('turns a thrown transport error into a value', async () => {
    // A CSP block inside the published artifact lands exactly here. It must not throw
    // into whatever was awaiting it.
    const provider = createTwelveDataProvider({
      http: () => Promise.reject(new Error('blocked by CSP')),
    });
    const result = await provider.fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
    expect(result.reason).toContain('CSP');
  });

  it('reports a non-JSON body as a format failure, not as no data', async () => {
    const { http } = scripted('<html>gateway timeout</html>');
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('format');
  });

  it('reports an empty series as not-found rather than as success', async () => {
    const { http } = scripted(JSON.stringify({ meta: {}, values: [] }));
    const result = await createTwelveDataProvider({ http }).fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('not-found');
  });
});

describe('searching', () => {
  it('returns hits with the exchange and currency that tell them apart', async () => {
    // Two rows both called TSLA. Without the exchange they are indistinguishable, and
    // picking the wrong one loads a chart priced in pesos.
    const { http } = scripted(SEARCH_BODY);
    const result = await createTwelveDataProvider({ http }).searchSymbols('tesla');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({ symbol: 'TSLA', exchange: 'NASDAQ', currency: 'USD' });
    expect(result.value[1]).toMatchObject({ symbol: 'TSLA', exchange: 'BMV', currency: 'MXN' });
  });

  it('sends no key, so search works before one is supplied', async () => {
    const { http, urls } = scripted(SEARCH_BODY);
    await createTwelveDataProvider({ http, apiKey: 'secret' }).searchSymbols('tesla');
    expect(urls[0]).not.toContain('secret');
    expect(urls[0]).not.toContain('apikey');
  });

  it('does not call out at all for an empty query', async () => {
    const { http, urls } = scripted(SEARCH_BODY);
    const result = await createTwelveDataProvider({ http }).searchSymbols('   ');
    expect(result.ok).toBe(true);
    expect(urls).toEqual([]);
  });
});

describe('quoting', () => {
  it('reads the last price and whether the venue is open', async () => {
    const { http } = scripted(QUOTE_BODY);
    const result = await createTwelveDataProvider({ http }).fetchQuote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.price).toBeCloseTo(305.26001, 5);
    expect(result.value.marketOpen).toBe(false);
  });

  it('reads the timestamp as SECONDS', async () => {
    // The field is epoch seconds. Taken as milliseconds it lands in January 1970, and the
    // live bar is appended half a century before the rest of the series.
    const { http } = scripted(QUOTE_BODY);
    const result = await createTwelveDataProvider({ http }).fetchQuote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.time).toBe(1786627800 * 1000);
    expect(new Date(result.value.time).getUTCFullYear()).toBe(2026);
  });

  it('reports an unknown market state as unknown, not as closed', async () => {
    const partial = JSON.stringify({ symbol: 'X', close: '10', timestamp: 1786627800 });
    const { http } = scripted(partial);
    const result = await createTwelveDataProvider({ http }).fetchQuote('X');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.marketOpen).toBeNull();
  });

  it('fails when there is no price, rather than quoting NaN', async () => {
    const { http } = scripted(JSON.stringify({ symbol: 'X' }));
    const result = await createTwelveDataProvider({ http }).fetchQuote('X');
    expect(result.ok).toBe(false);
  });
});
