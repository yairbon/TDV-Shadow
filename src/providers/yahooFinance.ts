/**
 * Yahoo Finance, through a same-origin proxy.
 *
 * The only free source verified to serve every timeframe this app draws — 1m, 5m, 15m, 1h,
 * 4h and 1d — for every symbol, in real time, with no key and no signup. Everything else
 * free is worse in a way that matters: Alpha Vantage gates intraday behind a paid plan,
 * Finnhub gates candles, Polygon allows five calls a minute on end-of-day data, and Twelve
 * Data's free key is real but capped at 800 requests a day and its shipped `demo` key
 * serves exactly one ticker.
 *
 * The catch, and the reason `vite.config.ts` exists: Yahoo sends no CORS header, so a
 * browser cannot call it directly. The dev server proxies `/yahoo/*`, which makes it a
 * same-origin request. That route exists only where something is proxying — not in a
 * static build and not in the published artifact — so `ready` is passed in by the caller
 * rather than assumed here. A provider that claims timeframes it cannot fetch is the exact
 * failure the capability layer exists to prevent.
 *
 * This is an UNOFFICIAL endpoint. It is not versioned, not documented, and can change
 * without notice. That is priced in: it sits ahead of the keyed providers in the chain, and
 * when it breaks the chain falls through to them rather than the chart going blank.
 *
 * ## What the wire actually looks like
 *
 * Verified against live responses rather than remembered:
 *
 * - Timestamps are epoch **seconds, UTC, bar open** — no timezone conversion needed, unlike
 *   Twelve Data. A 1-minute US bar arrives at 13:30:00Z, which is 09:30 New York.
 * - Daily and 4-hour bars are stamped at the **session** open (13:30Z), not UTC midnight,
 *   and Yahoo's own 4h buckets are session-aligned — better than rolling them up here,
 *   which would bucket on UTC boundaries and split every session.
 * - The OHLC arrays contain `null` holes at minutes with no trades.
 * - The LAST row is not a bar. Yahoo appends the live quote at `meta.regularMarketTime` —
 *   a precise trade time, so it does not sit on the interval lattice at all. Kept, it would
 *   put a bar open at 17:11:43 into a 1-minute series.
 * - `meta.validRanges` is wrong. It advertises `1y` and `max` for a 1-minute series that
 *   refuses anything past about eight days.
 */

import { makeBar, type Bar, type Timeframe } from '../data/types.js';
import {
  fail,
  ok,
  type HttpGet,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderResult,
  type Quote,
  type SeriesPage,
  type SymbolHit,
} from './types.js';

/** The proxy prefix. Must match the `server.proxy` key in `vite.config.ts`. */
export const YAHOO_PROXY = '/yahoo';

/** Every timeframe the app draws is served natively. The value is Yahoo's own spelling. */
const INTERVAL: Readonly<Record<Timeframe, string>> = Object.freeze({
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
});

/**
 * Derived from `INTERVAL`, not written out again.
 *
 * Two lists in one module that must agree is a smaller version of the same trap: adding an
 * interval to the map and forgetting the array would leave the provider quietly refusing to
 * CLAIM a timeframe it can perfectly well fetch. `INTERVAL` is a `Record<Timeframe, …>`, so
 * the compiler already forces it to stay exhaustive — which makes it the honest source.
 *
 * This stays a claim about what YAHOO serves rather than a restatement of `TIMEFRAMES`: a
 * provider that auto-claimed every timeframe the app invents is the lying-capability bug
 * this layer exists to prevent.
 */
const YAHOO_TIMEFRAMES: readonly Timeframe[] = Object.freeze(
  Object.keys(INTERVAL) as Timeframe[],
);

/**
 * Ranges Yahoo actually accepts per interval, smallest first, with the bars each yields.
 *
 * Measured, not taken from `meta.validRanges` — that field lists ranges the endpoint then
 * refuses. A 1-minute series accepts `7d` and rejects `1mo` with "Only 8 days worth of 1m
 * granularity data are allowed"; 5-minute accepts `60d` and rejects `90d`.
 */
const RANGES: Readonly<Record<Timeframe, readonly { range: string; bars: number }[]>> =
  Object.freeze({
    '1m': [
      { range: '1d', bars: 390 },
      { range: '5d', bars: 1950 },
      { range: '7d', bars: 2730 },
    ],
    '5m': [
      { range: '5d', bars: 390 },
      { range: '1mo', bars: 1700 },
      { range: '60d', bars: 4600 },
    ],
    '15m': [
      { range: '5d', bars: 130 },
      { range: '1mo', bars: 550 },
      { range: '60d', bars: 1550 },
    ],
    '1h': [
      { range: '1mo', bars: 150 },
      { range: '6mo', bars: 900 },
      { range: '2y', bars: 3500 },
    ],
    '4h': [
      { range: '1mo', bars: 45 },
      { range: '6mo', bars: 260 },
      { range: '2y', bars: 1000 },
    ],
    '1d': [
      { range: '1y', bars: 252 },
      { range: '5y', bars: 1260 },
      { range: 'max', bars: 20_000 },
    ],
  });

/** The smallest range that covers `limit`, or the largest available. */
export function rangeFor(timeframe: Timeframe, limit: number): string {
  const options = RANGES[timeframe];
  for (const option of options) if (option.bars >= limit) return option.range;
  return options[options.length - 1].range;
}

/** The slice of Yahoo's chart response this adapter reads. */
interface ChartResult {
  readonly meta?: {
    readonly regularMarketTime?: number;
    readonly regularMarketPrice?: number;
    readonly chartPreviousClose?: number;
    readonly previousClose?: number;
    readonly currency?: string;
    readonly currentTradingPeriod?: {
      readonly regular?: { readonly start?: number; readonly end?: number };
    };
  };
  readonly timestamp?: readonly number[];
  readonly indicators?: {
    readonly quote?: readonly {
      readonly open?: readonly (number | null)[];
      readonly high?: readonly (number | null)[];
      readonly low?: readonly (number | null)[];
      readonly close?: readonly (number | null)[];
      readonly volume?: readonly (number | null)[];
    }[];
  };
}

interface ChartResponse {
  readonly chart?: {
    readonly result?: readonly ChartResult[] | null;
    readonly error?: { readonly code?: string; readonly description?: string } | null;
  };
}

/**
 * Turns a chart payload into bars.
 *
 * Two rows are refused, and both would otherwise look like ordinary data:
 *
 * 1. Any row whose timestamp equals `meta.regularMarketTime` — that is the live quote
 *    Yahoo appends, stamped with a precise trade time rather than a bar open. A real bar
 *    open coinciding to the second with the last trade would be dropped too; that costs one
 *    partial bar and never invents a wrong one, which is the safe direction to be wrong in.
 * 2. Any row with a `null` in its OHLC, which is what a minute with no trades looks like.
 *
 * Both are counted as drops rather than silently skipped: a provider quietly losing a tenth
 * of its rows to a format change looks exactly like a thin market.
 */
export function parseChart(result: ChartResult): SeriesPage {
  const stamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0];
  const liveRow = result.meta?.regularMarketTime;
  const bars: Bar[] = [];
  let dropped = 0;

  for (const [index, seconds] of stamps.entries()) {
    if (!Number.isFinite(seconds) || (liveRow !== undefined && seconds === liveRow)) {
      dropped += 1;
      continue;
    }
    const bar = makeBar({
      t: Math.round(seconds) * 1000,
      o: quote?.open?.[index] ?? Number.NaN,
      h: quote?.high?.[index] ?? Number.NaN,
      l: quote?.low?.[index] ?? Number.NaN,
      c: quote?.close?.[index] ?? Number.NaN,
      // A null volume is a genuine zero-trade minute, not a malformed row — the price
      // fields carry the information and refusing the bar over its volume would punch a
      // hole in the series.
      v: quote?.volume?.[index] ?? 0,
    });
    if (bar === null) {
      dropped += 1;
      continue;
    }
    bars.push(bar);
  }
  return { bars, dropped };
}

/**
 * Classifies a chart error.
 *
 * `Unprocessable Entity` is this adapter's own bug, not the caller's — it means the
 * interval/range pair was rejected — so it reports as `format` with Yahoo's own sentence
 * rather than as something the reader could fix.
 */
export function classifyYahooError(code: string, description: string): ProviderResult<never> {
  const detail = description === '' ? code : description;
  if (/not found|delisted|no data/i.test(`${code} ${description}`)) {
    return fail('not-found', detail);
  }
  if (/too many|rate/i.test(code)) return fail('rate-limit', detail);
  return fail('format', detail);
}

export interface YahooOptions {
  /**
   * Whether the proxy is actually in front of this build.
   *
   * Passed in rather than sniffed, because there is no honest way to detect it
   * synchronously and the answer decides whether six timeframe buttons light up.
   */
  readonly ready: boolean;
  readonly http?: HttpGet;
  /** Overridden in tests; the proxy prefix otherwise. */
  readonly base?: string;
  readonly now?: () => number;
}

export function createYahooProvider(options: YahooOptions): MarketDataProvider {
  const base = options.base ?? YAHOO_PROXY;
  const now = options.now ?? (() => Date.now());
  const http =
    options.http ??
    (async (url: string) => {
      const response = await fetch(url);
      return { status: response.status, body: await response.text() };
    });

  const capabilities: ProviderCapabilities = Object.freeze({
    id: 'yahoo' as const,
    label: 'Yahoo Finance',
    nativeTimeframes: YAHOO_TIMEFRAMES,
    canSearch: true,
    canQuote: true,
    ready: options.ready,
  });

  /** Fetches and parses JSON, turning every failure into a value. */
  async function json<T>(url: string): Promise<ProviderResult<T>> {
    if (!options.ready) {
      return fail('no-key', 'Yahoo needs the dev-server proxy — run `npm run dev`');
    }
    let response: { status: number; body: string };
    try {
      response = await http(`${base}${url}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'network error';
      return fail('network', `Yahoo unreachable (${detail})`);
    }
    if (response.status === 429) return fail('rate-limit', 'Yahoo is rate limiting this client');
    if (response.status === 404) return fail('not-found', 'Yahoo has no such symbol');
    if (response.status >= 400) return fail('network', `Yahoo HTTP ${String(response.status)}`);
    try {
      return ok(JSON.parse(response.body) as T);
    } catch {
      // The overwhelmingly likely cause, and one worth naming: with no proxy in front, this
      // path is served by the app itself and the "response" is the page's own HTML.
      return fail(
        'network',
        'the Yahoo proxy is not running — this build served its own page instead',
      );
    }
  }

  return {
    capabilities: () => capabilities,

    async fetchSeries(symbol, timeframe, limit) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      const interval = INTERVAL[timeframe];
      const range = rangeFor(timeframe, limit);
      const response = await json<ChartResponse>(
        `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}`,
      );
      if (!response.ok) return response;

      const chart = response.value.chart;
      const error = chart?.error;
      if (error !== null && error !== undefined) {
        return classifyYahooError(error.code ?? '', error.description ?? '');
      }
      const result = chart?.result?.[0];
      if (result === undefined) return fail('not-found', `Yahoo returned no data for ${ticker}`);

      const page = parseChart(result);
      if (page.bars.length === 0) {
        return fail('not-found', `no ${timeframe} bars for ${ticker}`);
      }
      return ok(page);
    },

    async searchSymbols(query) {
      const trimmed = query.trim();
      if (trimmed === '') return ok([]);
      const response = await json<{
        quotes?: readonly {
          symbol?: string;
          shortname?: string;
          longname?: string;
          exchange?: string;
          exchDisp?: string;
          quoteType?: string;
        }[];
      }>(`/v1/finance/search?q=${encodeURIComponent(trimmed)}&quotesCount=20&newsCount=0`);
      if (!response.ok) return response;

      const hits: SymbolHit[] = [];
      for (const row of response.value.quotes ?? []) {
        const ticker = row.symbol ?? '';
        if (ticker === '') continue;
        // Futures, options and indices are in this index too, and none of them charts the
        // way the rest of the app assumes.
        const type = (row.quoteType ?? '').toUpperCase();
        if (type !== 'EQUITY' && type !== 'ETF') continue;
        hits.push({
          symbol: ticker,
          name: row.longname ?? row.shortname ?? ticker,
          exchange: row.exchDisp ?? row.exchange ?? '',
          // Yahoo's search index carries neither, and inventing "USD" for a listing in
          // Amsterdam would be worse than an empty column.
          currency: '',
          country: '',
        });
      }
      return ok(hits);
    },

    async fetchQuote(symbol) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      // The chart endpoint's own metadata carries the live price, so this is the same call
      // the series uses rather than a second endpoint to keep working.
      const response = await json<ChartResponse>(
        `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=1d`,
      );
      if (!response.ok) return response;
      const meta = response.value.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (price === undefined || !Number.isFinite(price)) {
        return fail('format', `no price in the quote for ${ticker}`);
      }
      const seconds = meta?.regularMarketTime;
      const period = meta?.currentTradingPeriod?.regular;
      const nowSeconds = now() / 1000;
      const marketOpen =
        period?.start === undefined || period.end === undefined
          ? null
          : nowSeconds >= period.start && nowSeconds < period.end;

      // `chartPreviousClose` is the baseline Yahoo itself uses for the day's change;
      // `previousClose` is its fallback on payloads that omit the first.
      const baseline = meta?.chartPreviousClose ?? meta?.previousClose;
      return ok({
        symbol: ticker,
        previousClose:
          baseline !== undefined && Number.isFinite(baseline) && baseline > 0 ? baseline : null,
        // Epoch SECONDS on the wire. Read as milliseconds it lands in 1970 and the live bar
        // is appended half a century early.
        time: (seconds === undefined ? now() : Math.round(seconds) * 1000) as Quote['time'],
        price,
        marketOpen,
      });
    },
  };
}
