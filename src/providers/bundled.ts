/**
 * The CSVs baked into the build.
 *
 * Last in the chain and never removable. The published artifact runs under a CSP that
 * blocks every outbound request, so without this the chart there would be permanently
 * empty — and the same applies to running offline, or to a key that has hit its daily
 * limit. It answers instantly, costs nothing, and cannot fail.
 *
 * It serves daily bars only, because that is what was baked. Declaring that honestly is
 * what makes the intraday buttons correctly report themselves unavailable when nothing
 * else in the chain is reachable, instead of offering four that cannot work.
 */

import type { Timeframe } from '../data/types.js';
import { parseDailyCsv, SYMBOLS, findSymbol } from '../app/marketData.js';
import {
  fail,
  ok,
  type MarketDataProvider,
  type ProviderCapabilities,
  type SymbolHit,
} from './types.js';

const BUNDLED_TIMEFRAMES: readonly Timeframe[] = Object.freeze<Timeframe[]>(['1d']);

export function createBundledProvider(): MarketDataProvider {
  const capabilities: ProviderCapabilities = Object.freeze({
    id: 'bundled',
    label: 'Bundled data',
    nativeTimeframes: BUNDLED_TIMEFRAMES,
    canSearch: true,
    canQuote: false,
    // Always ready: it needs no credential and no network, which is the whole point.
    ready: true,
  });

  return {
    capabilities: () => capabilities,

    fetchSeries(symbol, timeframe) {
      if (!BUNDLED_TIMEFRAMES.includes(timeframe)) {
        return Promise.resolve(
          fail('entitlement', `only daily bars are bundled — ${timeframe} needs a live provider`),
        );
      }
      const definition = findSymbol(symbol.trim().toUpperCase());
      if (definition === null || definition.csv === undefined) {
        return Promise.resolve(fail('not-found', `${symbol} is not bundled in this build`));
      }
      const bars = parseDailyCsv(definition.csv);
      if (bars.length === 0) {
        return Promise.resolve(fail('format', `bundled data for ${symbol} did not parse`));
      }
      // `parseDailyCsv` already validates and freezes; anything it rejected is gone before
      // this point, so there is no separate drop count to report.
      return Promise.resolve(ok({ bars, dropped: 0 }));
    },

    searchSymbols(query) {
      const needle = query.trim().toLowerCase();
      if (needle === '') return Promise.resolve(ok([]));
      const hits: SymbolHit[] = [];
      for (const definition of SYMBOLS) {
        if (definition.csv === undefined) continue;
        const haystack = `${definition.symbol} ${definition.label}`.toLowerCase();
        if (!haystack.includes(needle)) continue;
        hits.push({
          symbol: definition.symbol,
          // The label is "TSLA · Tesla"; the half after the separator is the name.
          name: definition.label.split('·').at(1)?.trim() ?? definition.label,
          exchange: 'bundled',
          currency: 'USD',
          country: 'United States',
        });
      }
      return Promise.resolve(ok(hits));
    },

    fetchQuote(symbol) {
      // Bundled history has no "latest price" — the newest bar is as current as it gets,
      // and presenting a months-old close as a live quote is exactly the lie the whole
      // stale-quote rule exists to prevent.
      return Promise.resolve(fail('not-found', `no live quote for ${symbol} from bundled data`));
    },
  };
}
