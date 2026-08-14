/**
 * Twelve Data — the intraday provider.
 *
 * Chosen because it is the only free source I could verify that serves 1min/5min/1h/1day
 * bars AND sends `access-control-allow-origin: *`, so the browser fetches it directly with
 * no proxy standing in the middle. Alpha Vantage gates every intraday endpoint behind a
 * premium key, which is why it cannot be the one that answers "live 1 minute".
 *
 * Three things about the wire format that the code below exists to handle:
 *
 * 1. **Errors arrive with `status: "error"` in a 200 body.** An HTTP 200 is not evidence
 *    of data here any more than it is at Alpha Vantage. The body is inspected first.
 * 2. **Values are newest-first.** The store requires strictly ascending `t`, so the rows
 *    are reversed. Feeding them through unreversed produces a series that every later
 *    stage quietly rejects.
 * 3. **Timestamps are naive exchange-local**, with the zone alongside in `meta`. They go
 *    through `zonedTimeToUtc` — see that module for the DST cases, which is where a
 *    whole-year hour shift would otherwise hide.
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
  type ProviderResult,
  type Quote,
  type SymbolHit,
} from './types.js';

const ENDPOINT = 'https://api.twelvedata.com';

/**
 * Our timeframes in Twelve Data's spelling. Every one of the six maps natively, which is
 * the reason this provider is worth having.
 */
const INTERVAL: Readonly<Record<Timeframe, string>> = Object.freeze({
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '1h': '1h',
  '4h': '4h',
  '1d': '1day',
});

/**
 * The key shipped in the build.
 *
 * `demo` is Twelve Data's public key. It serves a handful of symbols — enough that the
 * intraday path is provably real out of the box rather than a claim — and answers
 * everything else with a 401 telling you to get your own. Pass `?apikey=` to replace it.
 */
export const DEMO_KEY = 'demo';

interface Row {
  readonly datetime?: unknown;
  readonly open?: unknown;
  readonly high?: unknown;
  readonly low?: unknown;
  readonly close?: unknown;
  readonly volume?: unknown;
}

/** A number from a field the API sends as a string. NaN for anything unusable. */
function num(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string' || raw.trim() === '') return Number.NaN;
  return Number(raw);
}

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw : '';
}

/** Turns any thrown transport error into a `network` failure — nothing escapes as a throw. */
async function get(http: HttpGet, url: string): Promise<ProviderResult<unknown>> {
  let response: { status: number; body: string };
  try {
    response = await http(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'network error';
    return fail('network', `Twelve Data unreachable (${detail})`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch {
    return fail('format', `Twelve Data sent a non-JSON body (HTTP ${String(response.status)})`);
  }

  // The error shape rides inside a 200, so the body decides before the status does.
  if (typeof parsed === 'object' && parsed !== null && 'status' in parsed) {
    const record = parsed as { status?: unknown; code?: unknown; message?: unknown };
    if (record.status === 'error') {
      const code = num(record.code);
      const message = text(record.message) || 'request refused';
      if (code === 429) return fail('rate-limit', `Twelve Data rate limit: ${message}`);
      if (code === 401 || code === 403) return fail('entitlement', message);
      if (code === 404) return fail('not-found', message);
      return fail('format', message);
    }
  }
  if (response.status === 429) return fail('rate-limit', 'Twelve Data rate limit reached');
  if (response.status >= 400) return fail('network', `Twelve Data HTTP ${String(response.status)}`);
  return ok(parsed);
}

export interface TwelveDataOptions {
  readonly apiKey?: string;
  readonly http?: HttpGet;
}

export function createTwelveDataProvider(options: TwelveDataOptions = {}): MarketDataProvider {
  const key = (options.apiKey ?? '').trim() === '' ? DEMO_KEY : (options.apiKey ?? '').trim();
  const http = options.http ?? browserGet;

  const capabilities: ProviderCapabilities = Object.freeze({
    id: 'twelve-data',
    label: 'Twelve Data',
    // All six, natively. This is the whole reason the provider exists.
    nativeTimeframes: Object.freeze<Timeframe[]>(['1m', '5m', '15m', '1h', '4h', '1d']),
    canSearch: true,
    canQuote: true,
    ready: true,
  });

  return {
    capabilities: () => capabilities,

    async fetchSeries(symbol, timeframe, limit) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      const size = Math.max(1, Math.min(5000, Math.floor(limit)));
      const url =
        `${ENDPOINT}/time_series?symbol=${encodeURIComponent(ticker)}` +
        `&interval=${INTERVAL[timeframe]}&outputsize=${String(size)}` +
        `&apikey=${encodeURIComponent(key)}`;

      const response = await get(http, url);
      if (!response.ok) return response;

      const body = response.value as { meta?: { exchange_timezone?: unknown }; values?: unknown };
      const rows = body.values;
      if (!Array.isArray(rows)) return fail('format', 'Twelve Data sent no values array');
      if (rows.length === 0) return fail('not-found', `no ${timeframe} data for ${ticker}`);

      // Absent zone means UTC rather than "guess": guessing would shift a whole exchange's
      // bars by hours and still look like a chart.
      const zone = text(body.meta?.exchange_timezone) || 'UTC';

      const bars: Bar[] = [];
      let dropped = 0;
      // Newest-first on the wire; the store's §3.1 invariant is strictly ascending.
      for (let i = rows.length - 1; i >= 0; i--) {
        const row = rows[i] as Row;
        const t = zonedTimeToUtc(text(row.datetime), zone);
        if (t === null) {
          dropped++;
          continue;
        }
        // Volume is absent on some instruments (FX). Zero is the honest reading — the
        // series is still valid, it just carries no volume.
        const volume = num(row.volume);
        const bar = makeBar({
          t,
          o: num(row.open),
          h: num(row.high),
          l: num(row.low),
          c: num(row.close),
          v: Number.isFinite(volume) ? volume : 0,
        });
        if (bar === null) {
          dropped++;
          continue;
        }
        // Duplicate or out-of-order timestamps would break the ascending invariant. This
        // is where the fall-back repeat would show up if the zone maths ever regressed.
        const previous = bars.at(-1);
        if (previous !== undefined && bar.t <= previous.t) {
          dropped++;
          continue;
        }
        bars.push(bar);
      }

      if (bars.length === 0) {
        return fail('format', `every ${timeframe} row for ${ticker} was unusable`);
      }
      return ok({ bars, dropped });
    },

    async searchSymbols(query) {
      const trimmed = query.trim();
      if (trimmed === '') return ok([]);
      // Search needs no key at Twelve Data, so it works before one is supplied.
      const url = `${ENDPOINT}/symbol_search?symbol=${encodeURIComponent(trimmed)}&outputsize=20`;
      const response = await get(http, url);
      if (!response.ok) return response;

      const rows = (response.value as { data?: unknown }).data;
      if (!Array.isArray(rows)) return fail('format', 'Twelve Data sent no data array');

      const hits: SymbolHit[] = [];
      for (const raw of rows) {
        const row = raw as Record<string, unknown>;
        const ticker = text(row['symbol']);
        if (ticker === '') continue;
        hits.push({
          symbol: ticker,
          name: text(row['instrument_name']),
          exchange: text(row['exchange']),
          currency: text(row['currency']),
          country: text(row['country']),
        });
      }
      return ok(hits);
    },

    async fetchQuote(symbol) {
      const ticker = symbol.trim().toUpperCase();
      if (ticker === '') return fail('not-found', 'empty symbol');
      const url = `${ENDPOINT}/quote?symbol=${encodeURIComponent(ticker)}&apikey=${encodeURIComponent(key)}`;
      const response = await get(http, url);
      if (!response.ok) return response;

      const row = response.value as Record<string, unknown>;
      const price = num(row['close']);
      if (!Number.isFinite(price)) return fail('format', `no price in the quote for ${ticker}`);

      // `timestamp` is epoch SECONDS. Multiplying is not optional: a seconds value read as
      // milliseconds lands in 1970 and the live bar is appended half a century early.
      const seconds = num(row['timestamp']);
      const time = Number.isFinite(seconds) ? Math.round(seconds) * 1000 : Date.now();

      return ok({
        symbol: ticker,
        price,
        time: time as Quote['time'],
        marketOpen: typeof row['is_market_open'] === 'boolean' ? row['is_market_open'] : null,
      });
    },
  };
}
