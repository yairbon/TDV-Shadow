/**
 * Alpha Vantage over REST.
 *
 * Kept, rather than replaced by Twelve Data, for two reasons: it is the provider this app
 * already spoke to, and it is the one available *inside the published artifact* — where
 * there is no outbound HTTP at all and the only route to it is the viewer's connector (see
 * `alphaVantageMcp.ts`, which reuses everything below but the transport).
 *
 * **Its free tier has no intraday.** `TIME_SERIES_INTRADAY` answers "This is a premium
 * endpoint", as do the crypto and FX intraday variants, while `TIME_SERIES_DAILY` returns
 * data seconds later on the same key — so this is an entitlement wall and not a rate
 * limit. `capabilities()` therefore reports the daily family and nothing else, and the app
 * builds its timeframe buttons from that instead of offering four that cannot work.
 *
 * The other trap, shared with Twelve Data and already learned here once: an HTTP 200 is
 * not evidence of data. Errors, rate limits and entitlement walls all arrive as 200 with a
 * JSON body, while success is CSV.
 */

import type { Bar, Timeframe } from '../data/types.js';
import { makeBar } from '../data/types.js';
import { zonedTimeToUtc } from './zonedTime.js';
import {
  browserGet,
  fail,
  ok,
  type HttpGet,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderResult,
  type Quote,
  type SeriesPage,
  type SymbolHit,
} from './types.js';

export const ALPHA_VANTAGE_ENDPOINT = 'https://www.alphavantage.co/query';

/**
 * Daily bars are stamped at the session's own midnight, not UTC midnight.
 *
 * Alpha Vantage's daily rows carry a bare date and no zone. US equities are the
 * overwhelming majority of what it serves, so their calendar is the honest default —
 * reading the date as UTC midnight would place every daily bar four or five hours before
 * the session it describes.
 */
const DAILY_ZONE = 'America/New_York';

/** The timeframes a free key can actually serve. Intraday is premium; see the header. */
const FREE_TIMEFRAMES: readonly Timeframe[] = Object.freeze<Timeframe[]>(['1d']);

/**
 * Classifies an Alpha Vantage JSON body — which is always an error, since success is CSV.
 *
 * The distinction matters: "premium endpoint" must disable a timeframe permanently, while
 * "rate limit" must not. Both arrive under keys named `Information` or `Note`, so the
 * wording is the only thing that separates them.
 */
export function classifyAlphaVantageError(body: string): ProviderResult<never> {
  const message =
    /"(?:Information|Note|Error Message)":\s*"([^"]+)"/.exec(body)?.[1] ?? 'API returned an error';
  const lower = message.toLowerCase();
  if (lower.includes('premium')) return fail('entitlement', message);
  if (lower.includes('rate limit') || lower.includes('call frequency')) {
    return fail('rate-limit', message);
  }
  // "The demo API key is for demo purposes only. Please claim your free API key" — a
  // credential problem, and observed live. Classified as `format` it reads as a parser
  // bug in the status line and sends the reader looking in entirely the wrong place.
  if (lower.includes('api key')) return fail('no-key', message);
  if (lower.includes('invalid api call')) return fail('not-found', message);
  return fail('format', message);
}

/**
 * Parses the daily CSV: `timestamp,open,high,low,close,volume`, newest first.
 *
 * Returns bars ascending. Rows that do not parse are counted, per src/data/CLAUDE.md.
 */
export function parseDailyRows(csv: string): SeriesPage {
  const lines = csv.trim().split('\n');
  const bars: Bar[] = [];
  let dropped = 0;

  // Newest-first on the wire; the store wants strictly ascending.
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line === '' || line.toLowerCase().startsWith('timestamp')) continue;
    const cells = line.split(',');
    if (cells.length < 6) {
      dropped++;
      continue;
    }
    const t = zonedTimeToUtc(cells[0], DAILY_ZONE);
    if (t === null) {
      dropped++;
      continue;
    }
    const bar = makeBar({
      t,
      o: Number(cells[1]),
      h: Number(cells[2]),
      l: Number(cells[3]),
      c: Number(cells[4]),
      v: Number(cells[5]),
    });
    if (bar === null) {
      dropped++;
      continue;
    }
    const previous = bars.at(-1);
    if (previous !== undefined && bar.t <= previous.t) {
      dropped++;
      continue;
    }
    bars.push(bar);
  }
  return { bars, dropped };
}

/** Parses `SYMBOL_SEARCH`'s CSV. Columns: symbol,name,type,region,…,currency,matchScore. */
export function parseSearchRows(csv: string): SymbolHit[] {
  const lines = csv.trim().split('\n');
  const hits: SymbolHit[] = [];
  for (const line of lines) {
    const row = line.trim();
    if (row === '' || row.toLowerCase().startsWith('symbol,')) continue;
    const cells = row.split(',');
    if (cells.length < 8) continue;
    hits.push({
      symbol: cells[0],
      name: cells[1],
      exchange: cells[3],
      currency: cells[7],
      country: cells[3],
    });
  }
  return hits;
}

/** Parses `GLOBAL_QUOTE`'s CSV: symbol,open,high,low,price,volume,latestDay,… */
export function parseQuoteRow(
  csv: string,
): { symbol: string; price: number; day: string; previousClose: number | null } | null {
  const lines = csv.trim().split('\n');
  for (const line of lines) {
    const row = line.trim();
    if (row === '' || row.toLowerCase().startsWith('symbol,')) continue;
    const cells = row.split(',');
    if (cells.length < 7) continue;
    const price = Number(cells[4]);
    if (!Number.isFinite(price)) return null;
    // `symbol,open,high,low,price,volume,latestDay,previousClose,…` — column 7, present on
    // every GLOBAL_QUOTE row observed, but the row is still served without it.
    const previous = cells.length > 7 ? Number(cells[7]) : Number.NaN;
    return {
      symbol: cells[0],
      price,
      day: cells[6],
      previousClose: Number.isFinite(previous) && previous > 0 ? previous : null,
    };
  }
  return null;
}

/**
 * The transport-agnostic half.
 *
 * `request` takes the query parameters and returns a raw body, so the REST provider below
 * and the MCP provider share every line of parsing and classification. The two differ
 * only in how bytes are obtained, and that is the only thing worth writing twice.
 */
export type AlphaVantageRequest = (
  params: Readonly<Record<string, string>>,
) => Promise<ProviderResult<string>>;

export function createAlphaVantageCore(
  request: AlphaVantageRequest,
  id: ProviderId,
  label: string,
  ready: boolean,
): MarketDataProvider {
  const capabilities: ProviderCapabilities = Object.freeze({
    id,
    label,
    nativeTimeframes: FREE_TIMEFRAMES,
    canSearch: true,
    canQuote: true,
    ready,
  });

  return {
    capabilities: () => capabilities,

    async fetchSeries(symbol, timeframe, limit) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      if (!FREE_TIMEFRAMES.includes(timeframe)) {
        // Stated rather than attempted. The request would cost one of a 25-a-day budget
        // and come back with the same answer every time.
        return fail(
          'entitlement',
          `Alpha Vantage serves ${timeframe} only on a premium key — intraday is not on the free tier`,
        );
      }

      const response = await request({
        function: 'TIME_SERIES_DAILY',
        symbol: ticker,
        outputsize: limit > 100 ? 'full' : 'compact',
        datatype: 'csv',
      });
      if (!response.ok) return response;

      const body = response.value;
      if (body.trimStart().startsWith('{')) return classifyAlphaVantageError(body);
      if (!body.toLowerCase().startsWith('timestamp')) {
        return fail('format', 'Alpha Vantage sent an unexpected response format');
      }
      const page = parseDailyRows(body);
      if (page.bars.length === 0) return fail('not-found', `no daily data for ${ticker}`);
      return ok(page);
    },

    async searchSymbols(query) {
      const trimmed = query.trim();
      if (trimmed === '') return ok([]);
      const response = await request({
        function: 'SYMBOL_SEARCH',
        keywords: trimmed,
        datatype: 'csv',
      });
      if (!response.ok) return response;
      const body = response.value;
      if (body.trimStart().startsWith('{')) return classifyAlphaVantageError(body);
      return ok(parseSearchRows(body));
    },

    async fetchQuote(symbol) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      const response = await request({
        function: 'GLOBAL_QUOTE',
        symbol: ticker,
        datatype: 'csv',
      });
      if (!response.ok) return response;
      const body = response.value;
      if (body.trimStart().startsWith('{')) return classifyAlphaVantageError(body);

      const row = parseQuoteRow(body);
      if (row === null) return fail('format', `no price in the quote for ${ticker}`);
      const time = zonedTimeToUtc(row.day, DAILY_ZONE);
      return ok({
        symbol: row.symbol === '' ? ticker : row.symbol,
        price: row.price,
        previousClose: row.previousClose,
        time: (time ?? Date.now()) as Quote['time'],
        // GLOBAL_QUOTE says nothing about whether the venue is open, and guessing from the
        // date would call a holiday "open" every time the previous session was recent.
        marketOpen: null,
      });
    },
  };
}

export interface AlphaVantageOptions {
  readonly apiKey?: string;
  readonly http?: HttpGet;
}

export function createAlphaVantageProvider(
  options: AlphaVantageOptions = {},
): MarketDataProvider {
  const key = (options.apiKey ?? '').trim();
  const http = options.http ?? browserGet;

  const request: AlphaVantageRequest = async (params) => {
    if (key === '') {
      return fail('no-key', 'no Alpha Vantage key — add ?avkey=YOUR_KEY');
    }
    const query = new URLSearchParams({ ...params, apikey: key }).toString();
    try {
      const response = await http(`${ALPHA_VANTAGE_ENDPOINT}?${query}`);
      if (response.status === 429) return fail('rate-limit', 'Alpha Vantage rate limit reached');
      if (response.status >= 400) {
        return fail('network', `Alpha Vantage HTTP ${String(response.status)}`);
      }
      return ok(response.body);
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'network error';
      return fail('network', `Alpha Vantage unreachable (${detail})`);
    }
  };

  return createAlphaVantageCore(request, 'alpha-vantage', 'Alpha Vantage', key !== '');
}
