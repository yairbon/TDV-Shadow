/**
 * The provider chain the app actually talks to.
 *
 * Assembles, in preference order:
 *
 * 0. **Yahoo Finance** — every timeframe, every symbol, real time, no key, and therefore
 *    first whenever it is available at all. It is only available behind a same-origin
 *    proxy (see `vite.config.ts`), so `yahoo` is opt-in and defaults off; an unofficial
 *    endpoint sitting first is safe precisely because the chain falls through when it
 *    breaks.
 * 1. **Twelve Data** — the only free source verified to serve 1m/5m/1h/1d over CORS, so
 *    it is the one that answers "live 1 minute". Ships with the vendor's `demo` key, which
 *    serves a handful of symbols; `?apikey=` replaces it.
 * 2. **Alpha Vantage** — daily only on a free key, and present because it is the provider
 *    reachable from inside the published artifact through the viewer's connector.
 * 3. **Bundled** — the CSVs baked into the build. Not a fallback for convenience: the
 *    published artifact has no network at all, so without this the chart there would be
 *    permanently empty. It is also what makes the app work offline.
 *
 * Order matters and is by capability, not by preference alone: `resolveAcross` takes a
 * native resolution wherever it lives, so daily comes from whichever provider serves it
 * and intraday comes from the one that can.
 */

import { TIMEFRAME_MS, TIMEFRAMES, type Bar, type Timeframe } from '../data/types.js';
import { resolveAcross, resolveTimeframe, type Resolution } from './resolve.js';
import { resample } from '../data/agg/resample.js';
import { createYahooProvider } from './yahooFinance.js';
import { createTwelveDataProvider } from './twelveData.js';
import { createAlphaVantageProvider } from './alphaVantage.js';
import { createBundledProvider } from './bundled.js';
import { browserCacheStore, withCache } from './cache.js';
import {
  fail,
  ok,
  type MarketDataProvider,
  type ProviderCapabilities,
  type ProviderId,
  type ProviderResult,
  type Quote,
  type SymbolHit,
} from './types.js';

/** A resolved series, with everything the UI needs to describe it honestly. */
export interface LoadedSeries {
  readonly bars: readonly Bar[];
  readonly timeframe: Timeframe;
  /** Which provider answered, for the status line. */
  readonly provider: string;
  /**
   * The same provider's id.
   *
   * Carried alongside the label because the caller has to make a DECISION on it, not just
   * print it: bars that came from the bundled CSV cannot be polled for a quote and must
   * not be offered as live, and matching on a display string to work that out is the kind
   * of test that breaks the day someone rewords a label.
   */
  readonly providerId: ProviderId;
  readonly origin: Resolution['origin'];
  /**
   * The timeframe actually fetched. Equal to `timeframe` unless it was rolled up, and
   * carried so the status line can name the source rather than repeating the word
   * "resampled" back at the reader.
   */
  readonly sourceTimeframe: Timeframe;
  /** True when this came from cache after a live fetch failed. */
  readonly stale: boolean;
}

export interface MarketData {
  /** Every timeframe, resolved against the chain — for building the buttons. */
  timeframes(): readonly (Resolution & { readonly provider: string | null })[];
  series(symbol: string, timeframe: Timeframe, limit?: number): Promise<ProviderResult<LoadedSeries>>;
  search(query: string): Promise<ProviderResult<readonly SymbolHit[]>>;
  quote(symbol: string): Promise<ProviderResult<Quote>>;
  /** The chain, for diagnostics and for the settings sheet. */
  providers(): readonly ProviderCapabilities[];
  /**
   * Swaps the whole chain out, as `only` does at construction.
   *
   * This exists for one case, and it is not a test seam: inside the published artifact the
   * only usable provider is reached through `claude.use('mcp')`, which is a promise, while
   * the app needs a chain the moment it boots. So it boots with the chain that works
   * everywhere and replaces it if the connector turns out to be available. Callers must
   * re-read `timeframes()` afterwards — the buttons were built from the old chain.
   */
  replaceChain(providers: readonly MarketDataProvider[]): void;
}

export interface MarketDataOptions {
  readonly twelveDataKey?: string;
  readonly alphaVantageKey?: string;
  /** Extra providers, ahead of the built-in ones. The MCP provider arrives this way. */
  readonly extra?: readonly MarketDataProvider[];
  /**
   * Replaces the built-in chain entirely.
   *
   * Needed for the published artifact, not just for tests: there, no outbound HTTP is
   * possible, so leaving the REST providers in the chain would have them claim every
   * timeframe natively, light up all six buttons, and fail on each press with a network
   * error — precisely the lying-button problem this layer exists to remove.
   */
  readonly only?: readonly MarketDataProvider[];
  /**
   * Put Yahoo Finance at the head of the chain.
   *
   * Only true where a same-origin proxy is actually serving `/yahoo` — the dev server, or
   * a host the reader has configured themselves. Off by default because the published
   * artifact and any plain static build have no such route, and a provider that claims six
   * timeframes it cannot fetch is worse than one that is absent.
   */
  readonly yahoo?: boolean;
  /** Off in tests, so nothing touches `localStorage`. */
  readonly persist?: boolean;
}

/** How many bars to ask for when the caller does not say. */
const DEFAULT_LIMIT = 500;

/**
 * How long one provider may hold up a request, per kind.
 *
 * Every one of these paths awaits a provider, and a provider that never answers is not a
 * hypothetical: a firewall, an extension blocking a finance domain, or a sandbox with no
 * egress all produce a promise that simply never settles. Without a deadline the caller
 * waits forever — the symbol load that prompted this sat on "loading ZZZZZZ…" indefinitely
 * because the first provider said not-found and the second never replied at all.
 *
 * The values differ because the requests do. A series is the largest payload and the one
 * worth waiting on; a quote is small and is polled again shortly anyway; a search is
 * interactive and a reader watching a spinner gives up long before three seconds.
 */
const TIMEOUT_MS = Object.freeze({ series: 10_000, quote: 6000, search: 3000 });

/** Resolves to `promise`, or to a failure once `ms` has passed. */
function withTimeout<T>(
  promise: Promise<ProviderResult<T>>,
  label: string,
  ms: number,
): Promise<ProviderResult<T>> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(fail('network', `${label} did not answer in time`));
    }, ms);
    const settle = (result: ProviderResult<T>): void => {
      clearTimeout(timer);
      resolve(result);
    };
    promise.then(settle, (error: unknown) => {
      // A provider is not supposed to reject, but one that does must not take the caller
      // down with it — the next provider in the chain may well answer.
      const detail = error instanceof Error ? error.message : 'failed';
      settle(fail('network', `${label}: ${detail}`));
    });
  });
}

export function createMarketData(options: MarketDataOptions = {}): MarketData {
  const store = options.persist === false ? undefined : browserCacheStore();
  const wrap = (provider: MarketDataProvider): MarketDataProvider =>
    withCache(provider, store === undefined ? {} : { store });

  let chain: MarketDataProvider[] =
    options.only !== undefined
      ? [...options.only]
      : [
          ...(options.extra ?? []),
          ...(options.yahoo === true ? [wrap(createYahooProvider({ ready: true }))] : []),
          wrap(
            createTwelveDataProvider(
              options.twelveDataKey === undefined ? {} : { apiKey: options.twelveDataKey },
            ),
          ),
          wrap(
            createAlphaVantageProvider(
              options.alphaVantageKey === undefined ? {} : { apiKey: options.alphaVantageKey },
            ),
          ),
          // Last, and never removed: the only provider that works with no network at all.
          createBundledProvider(),
        ];

  const capabilities = (): ProviderCapabilities[] => chain.map((p) => p.capabilities());

  /**
   * The provider that should answer for a timeframe, and how.
   *
   * Resolved by POSITION rather than by looking the capability's id back up: two providers
   * can legitimately share an id — an MCP and a REST Alpha Vantage are both
   * `alpha-vantage` — and a map keyed by id silently hands the request to whichever was
   * inserted last, which is a different provider from the one whose capabilities were
   * consulted.
   */
  interface Candidate {
    readonly provider: MarketDataProvider;
    readonly capability: ProviderCapabilities;
    readonly resolution: Resolution;
  }

  const pick = (timeframe: Timeframe): Candidate | null => {
    const caps = capabilities();
    const chosen = resolveAcross(caps, timeframe);
    if (chosen === null) return null;
    const index = caps.indexOf(chosen.provider);
    const provider = chain.at(index);
    if (provider === undefined) return null;
    return { provider, capability: chosen.provider, resolution: chosen.resolution };
  };

  /**
   * EVERY provider that could serve `timeframe`, best resolution first.
   *
   * `pick` alone made the chain a chain in name only: it named one provider, and a failure
   * there ended the request. So a connector that was momentarily unreachable did not fall
   * through to the CSVs sitting behind it in the same chain — the chart simply refused to
   * load a symbol it had the data for. `quote()` already looped; this is the same rule.
   *
   * Order is by resolution quality first — a native answer anywhere beats a resampled one,
   * as `resolveAcross` decides — and by chain position within that.
   */
  const candidates = (timeframe: Timeframe): Candidate[] => {
    const caps = capabilities();
    const best = pick(timeframe);
    const out: Candidate[] = best === null ? [] : [best];
    for (const [index, capability] of caps.entries()) {
      if (best !== null && capability === best.capability) continue;
      if (!capability.ready) continue;
      const resolution = resolveTimeframe(capability, timeframe);
      if (resolution.origin === 'unavailable') continue;
      const provider = chain.at(index);
      if (provider === undefined) continue;
      out.push({ provider, capability, resolution });
    }
    return out;
  };

  return {
    providers: capabilities,

    replaceChain(providers) {
      chain = [...providers];
    },

    timeframes() {
      const caps = capabilities();
      const seen = new Set<Timeframe>();
      const out: (Resolution & { provider: string | null })[] = [];
      for (const timeframe of TIMEFRAMES) {
        if (seen.has(timeframe)) continue;
        seen.add(timeframe);
        const chosen = resolveAcross(caps, timeframe);
        if (chosen === null) {
          // No provider can serve it. The reason comes from whichever provider is ready,
          // so the button says something specific rather than a generic refusal.
          const ready = caps.find((candidate) => candidate.ready) ?? caps.at(0);
          out.push({
            timeframe,
            origin: 'unavailable',
            fetchAs: timeframe,
            // `resolveTimeframe`, not `resolveAcross`: the latter answers null for exactly
            // the case being reported here, so its reason was always discarded and every
            // disabled button fell through to the generic phrasing. The specific reason —
            // "intraday is not on the free tier" — is the one thing that tells the reader
            // whether a different key would fix it.
            reason:
              ready === undefined
                ? 'no data provider is configured'
                : resolveTimeframe(ready, timeframe).reason,
            provider: null,
          });
          continue;
        }
        out.push({ ...chosen.resolution, provider: chosen.provider.label });
      }
      return out;
    },

    async series(symbol, timeframe, limit = DEFAULT_LIMIT) {
      const options = candidates(timeframe);
      if (options.length === 0) {
        return fail('entitlement', `no configured provider serves ${timeframe}`);
      }

      // The FIRST failure, not the last: `candidates` is ordered best-resolution-first, so
      // the head of the list is the provider that should have answered and its refusal is
      // the informative one. The tail is typically the bundled CSV replying that a ticker
      // it never shipped with is not in the build — true, and useless.
      let firstFailure: ProviderResult<never> | null = null;
      for (const { provider, capability, resolution } of options) {
        // A resampled target needs proportionally more source bars, or the roll-up
        // produces a handful of buckets from a full request.
        const factor =
          resolution.origin === 'resampled'
            ? Math.max(1, Math.round(TIMEFRAME_MS[timeframe] / TIMEFRAME_MS[resolution.fetchAs]))
            : 1;
        const page = await withTimeout(
          provider.fetchSeries(symbol, resolution.fetchAs, limit * factor),
          capability.label,
          TIMEOUT_MS.series,
        );
        if (!page.ok) {
          firstFailure ??= page;
          continue;
        }

        const bars =
          resolution.origin === 'resampled'
            ? resample(page.value.bars, resolution.fetchAs, timeframe)
            : page.value.bars;
        if (bars.length === 0) {
          firstFailure ??= fail('not-found', `no ${timeframe} bars for ${symbol}`);
          continue;
        }

        return ok({
          bars,
          timeframe,
          provider: capability.label,
          providerId: capability.id,
          origin: resolution.origin,
          sourceTimeframe: resolution.fetchAs,
          // `withCache` reports staleness on its own richer method; through the plain
          // interface a served-from-stale result is indistinguishable, so this is only
          // true when the provider itself said so.
          stale: false,
        });
      }

      // Every provider that could have served it was asked, and none did.
      return firstFailure ?? fail('not-found', `no ${timeframe} bars for ${symbol}`);
    },

    async search(query) {
      const trimmed = query.trim();
      if (trimmed === '') return ok([]);
      // Every provider that can search, merged — Twelve Data covers more venues, Alpha
      // Vantage sometimes has a name the other misses. Duplicates are collapsed by
      // (symbol, exchange), which is the pair that identifies an instrument.
      //
      // `ready` as well as `canSearch`, matching `quote()`: a provider with no credential
      // has already said it will refuse everything, so calling it buys nothing and costs
      // something real — its "no key" refusal is the LAST failure recorded, so when the
      // provider that could have answered is rate-limited, the reader is told to add a key
      // for a provider they were not using instead of being told they ran out of credits.
      const searchable = chain.filter((provider) => {
        const capability = provider.capabilities();
        return capability.ready && capability.canSearch;
      });
      const results = await Promise.all(
        searchable.map((provider) =>
          withTimeout(provider.searchSymbols(trimmed), provider.capabilities().label, TIMEOUT_MS.search),
        ),
      );

      const merged: SymbolHit[] = [];
      const seen = new Set<string>();
      let lastFailure: ProviderResult<readonly SymbolHit[]> | null = null;
      for (const result of results) {
        if (!result.ok) {
          lastFailure = result;
          continue;
        }
        for (const hit of result.value) {
          const key = `${hit.symbol}@${hit.exchange}`;
          if (seen.has(key)) continue;
          seen.add(key);
          merged.push(hit);
        }
      }
      if (merged.length === 0 && lastFailure !== null) return lastFailure;
      return ok(merged);
    },

    async quote(symbol) {
      for (const provider of chain) {
        const caps = provider.capabilities();
        if (!caps.ready || !caps.canQuote) continue;
        const result = await withTimeout(provider.fetchQuote(symbol), caps.label, TIMEOUT_MS.quote);
        if (result.ok) return result;
        // A `not-found` here means this provider does not carry the symbol; the next one
        // might. Anything else is a real problem worth reporting rather than papering
        // over by trying every provider in turn.
        if (result.kind !== 'not-found') return result;
      }
      return fail('not-found', `no provider quoted ${symbol}`);
    },
  };
}
