/**
 * Optional live symbol loading.
 *
 * Why the bundled snapshot exists at all: the published artifact runs under a strict CSP
 * with NO network, so a chart that could only fetch would be permanently empty there.
 * When the app runs somewhere with network access and an Alpha Vantage key, this module
 * lifts the symbol list from "the six we baked" to "any ticker the API knows".
 *
 * Supply the key as `?apikey=...` in the URL. It is never persisted, and the request
 * fails closed: on any error the caller keeps whatever it already had rather than
 * showing an empty chart or, worse, another symbol's bars under a new name.
 */

import type { Bar } from '../data/types.js';
import { parseDailyCsv } from './marketData.js';

export interface LiveFetchResult {
  readonly ok: boolean;
  readonly bars: readonly Bar[];
  /** Human-readable reason when `ok` is false — shown in the status line, not swallowed. */
  readonly reason: string;
}

const ENDPOINT = 'https://www.alphavantage.co/query';

export async function fetchDailySeries(symbol: string, apiKey: string): Promise<LiveFetchResult> {
  const ticker = symbol.trim().toUpperCase();
  if (ticker === '') return { ok: false, bars: [], reason: 'empty symbol' };
  if (apiKey.trim() === '') {
    return { ok: false, bars: [], reason: 'no API key — add ?apikey=YOUR_KEY to load new symbols' };
  }

  const url =
    `${ENDPOINT}?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(ticker)}` +
    `&outputsize=compact&datatype=csv&apikey=${encodeURIComponent(apiKey.trim())}`;

  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { ok: false, bars: [], reason: `HTTP ${String(response.status)}` };
    }
    const text = await response.text();

    // Alpha Vantage answers errors and rate limits with HTTP 200 and a JSON body, so a
    // 200 is not evidence of data. Detect the shape before trusting it.
    if (text.trimStart().startsWith('{')) {
      const message = /"(?:Information|Note|Error Message)":\s*"([^"]+)"/.exec(text)?.[1];
      return { ok: false, bars: [], reason: message ?? 'API returned an error' };
    }
    if (!text.toLowerCase().startsWith('timestamp')) {
      return { ok: false, bars: [], reason: 'unexpected response format' };
    }

    const bars = parseDailyCsv(text.split('\n').slice(1).join('\n'));
    if (bars.length === 0) return { ok: false, bars: [], reason: `no data for ${ticker}` };
    return { ok: true, bars, reason: '' };
  } catch (error) {
    // A CSP block or an offline runner lands here. Say so plainly.
    const detail = error instanceof Error ? error.message : 'network error';
    return { ok: false, bars: [], reason: `fetch blocked or offline (${detail})` };
  }
}
