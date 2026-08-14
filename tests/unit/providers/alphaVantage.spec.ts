/**
 * The Alpha Vantage adapter.
 *
 * The fixtures are real bodies observed from the live API, including the one that matters
 * most: the premium refusal. Classifying that as a rate limit — they arrive under the same
 * JSON keys and differ only in wording — would have the app retrying forever against a
 * wall, burning a 25-a-day budget on an answer that cannot change.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyAlphaVantageError,
  createAlphaVantageProvider,
  parseDailyRows,
} from '../../../src/providers/alphaVantage.js';
import type { HttpGet } from '../../../src/providers/types.js';

/** Observed from TIME_SERIES_DAILY: header, then newest-first rows. */
const DAILY_CSV = [
  'timestamp,open,high,low,close,volume',
  '2026-08-13,304.2100,306.0000,302.0500,305.2600,39394350',
  '2026-08-12,305.1000,305.6600,300.5700,302.2500,41657768',
  '2026-08-11,307.7500,309.9700,302.7900,304.9100,37476746',
].join('\n');

/** Observed from GLOBAL_QUOTE. */
const QUOTE_CSV = [
  'symbol,open,high,low,price,volume,latestDay,previousClose,change,changePercent',
  'AAPL,304.2100,306.0000,302.0500,305.2600,39394350,2026-08-13,302.2500,3.0100,0.9959%',
].join('\n');

/** Observed from SYMBOL_SEARCH. */
const SEARCH_CSV = [
  'symbol,name,type,region,marketOpen,marketClose,timezone,currency,matchScore',
  'TSLA,Tesla Inc,Equity,United States,09:30,16:00,UTC-04,USD,0.8889',
  'TL0.DEX,Tesla Inc,Equity,XETRA,08:00,20:00,UTC+02,EUR,0.7143',
].join('\n');

/** The exact body TIME_SERIES_INTRADAY returns on a free key. */
const PREMIUM_BODY = JSON.stringify({
  Information:
    'Thank you for using Alpha Vantage! This is a premium endpoint. You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to instantly unlock all premium endpoints',
});

const RATE_LIMIT_BODY = JSON.stringify({
  Note: 'Thank you for using Alpha Vantage! Our standard API call frequency is 5 calls per minute',
});

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

describe('classifying an error body', () => {
  it('separates the premium wall from a rate limit', () => {
    // The distinction the whole plan turned on. Same JSON keys; only the wording differs.
    const premium = classifyAlphaVantageError(PREMIUM_BODY);
    expect(premium.ok).toBe(false);
    if (premium.ok) return;
    expect(premium.kind).toBe('entitlement');

    const limited = classifyAlphaVantageError(RATE_LIMIT_BODY);
    expect(limited.ok).toBe(false);
    if (limited.ok) return;
    expect(limited.kind).toBe('rate-limit');
  });

  it('carries the vendor’s own words through to the caller', () => {
    const result = classifyAlphaVantageError(PREMIUM_BODY);
    if (result.ok) return;
    expect(result.reason).toContain('premium');
  });

  it('calls a missing or demo key what it is', () => {
    // Observed live: this exact body comes back for every endpoint on the demo key. Read
    // as a format error it points at the parser instead of at the missing credential.
    const body = JSON.stringify({
      Information:
        'The **demo** API key is for demo purposes only. Please claim your free API key at https://www.alphavantage.co/support/#api-key',
    });
    const result = classifyAlphaVantageError(body);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('no-key');
  });

  it('reports an unrecognised body rather than inventing a cause', () => {
    const result = classifyAlphaVantageError('{"Something":"else"}');
    if (result.ok) return;
    expect(result.kind).toBe('format');
  });
});

describe('capabilities', () => {
  it('claims daily only, because intraday is premium', () => {
    // If this ever grows to include 1m, the app will offer a button that always fails.
    const caps = createAlphaVantageProvider({ apiKey: 'k' }).capabilities();
    expect(caps.nativeTimeframes).toEqual(['1d']);
  });

  it('is not ready without a key', () => {
    expect(createAlphaVantageProvider().capabilities().ready).toBe(false);
    expect(createAlphaVantageProvider({ apiKey: 'k' }).capabilities().ready).toBe(true);
  });
});

describe('fetching a series', () => {
  it('returns ascending bars from newest-first CSV', async () => {
    const { http } = scripted(DAILY_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchSeries(
      'AAPL',
      '1d',
      100,
    );
    if (!result.ok) throw new Error(result.reason);
    const { bars } = result.value;
    expect(bars).toHaveLength(3);
    for (let i = 1; i < bars.length; i++) expect(bars[i].t).toBeGreaterThan(bars[i - 1].t);
    expect(bars[0].c).toBeCloseTo(304.91, 6);
    expect(bars[2].c).toBeCloseTo(305.26, 6);
  });

  it('stamps a daily bar at the session midnight, not UTC midnight', async () => {
    // 2026-08-13 in New York is EDT, so its midnight is 04:00Z. Reading the bare date as
    // UTC would place every daily bar four hours before the session it describes.
    const { http } = scripted(DAILY_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchSeries(
      'AAPL',
      '1d',
      100,
    );
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.bars[2].t).toBe(Date.UTC(2026, 7, 13, 4, 0, 0));
  });

  it('refuses an intraday timeframe without spending a request on it', async () => {
    // The budget is 25 a day. Asking would return the same wall every time.
    const { http, urls } = scripted(DAILY_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchSeries(
      'AAPL',
      '1m',
      100,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('entitlement');
    expect(urls).toEqual([]);
  });

  it('reads a JSON error out of a 200 instead of trusting the status', async () => {
    const { http } = scripted(PREMIUM_BODY, 200);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchSeries(
      'AAPL',
      '1d',
      100,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('entitlement');
  });

  it('says so plainly when there is no key, without calling out', async () => {
    const { http, urls } = scripted(DAILY_CSV);
    const result = await createAlphaVantageProvider({ http }).fetchSeries('AAPL', '1d', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('no-key');
    expect(urls).toEqual([]);
  });

  it('counts unparseable rows rather than dropping them silently', () => {
    const messy = [
      'timestamp,open,high,low,close,volume',
      '2026-08-13,304.21,306.00,302.05,305.26,39394350',
      'not-a-date,1,2,0.5,1.5,10',
      '2026-08-11,9,2,0.5,1.5,10', // high below open: an impossible bar
      'short,row',
    ].join('\n');
    const page = parseDailyRows(messy);
    expect(page.bars).toHaveLength(1);
    expect(page.dropped).toBe(3);
  });

  it('turns a thrown transport error into a value', async () => {
    const provider = createAlphaVantageProvider({
      apiKey: 'k',
      http: () => Promise.reject(new Error('blocked')),
    });
    const result = await provider.fetchSeries('AAPL', '1d', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('network');
  });
});

describe('searching and quoting', () => {
  it('reads hits with the region and currency that tell them apart', async () => {
    const { http } = scripted(SEARCH_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).searchSymbols('tesla');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value).toHaveLength(2);
    expect(result.value[0]).toMatchObject({ symbol: 'TSLA', currency: 'USD' });
    expect(result.value[1]).toMatchObject({ symbol: 'TL0.DEX', currency: 'EUR' });
  });

  it('reads the last price out of a quote', async () => {
    const { http } = scripted(QUOTE_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchQuote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.price).toBeCloseTo(305.26, 6);
    expect(result.value.symbol).toBe('AAPL');
  });

  it('reports the market state as unknown, because the endpoint does not say', async () => {
    // Inferring "open" from a recent date would call every holiday a trading day.
    const { http } = scripted(QUOTE_CSV);
    const result = await createAlphaVantageProvider({ apiKey: 'k', http }).fetchQuote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.marketOpen).toBeNull();
  });
});
