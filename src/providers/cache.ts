/**
 * Caching and request coalescing, as a decorator over any provider.
 *
 * Not an optimization. The free Alpha Vantage tier allows 25 requests a DAY, and Twelve
 * Data's allows 8 a minute — so clicking through four timeframes and back is enough to
 * exhaust a budget and leave the app rate-limited for hours. Without this layer the
 * feature does not work; with it, the same clicking costs nothing after the first pass.
 *
 * Three things it does, in the order they matter:
 *
 * 1. **Coalesces in-flight requests.** Two callers asking for the same series at the same
 *    moment — which happens the instant a symbol change and a timeframe change race — get
 *    one request and the same promise. This is the cheapest of the three and the one that
 *    prevents the worst bursts.
 * 2. **Serves fresh entries without asking.** TTL is per timeframe, because a 1-minute bar
 *    is stale in a minute and a daily bar is not stale until the next close.
 * 3. **Serves STALE entries when the provider refuses.** A rate limit with yesterday's
 *    daily bars in hand should show yesterday's bars and say so, not an empty chart. The
 *    result carries `stale` so the caller can label it honestly rather than passing old
 *    data off as current.
 *
 * Storage is injected. The default persists to `localStorage`, so a reload does not spend
 * the budget again; tests pass a Map and a fake clock and never touch either.
 */

import type { Timeframe } from '../data/types.js';
import { makeBar } from '../data/types.js';
import type {
  MarketDataProvider,
  ProviderCapabilities,
  ProviderResult,
  Quote,
  SeriesPage,
  SymbolHit,
} from './types.js';
import { fail, ok } from './types.js';

/**
 * How long a series of each timeframe stays fresh.
 *
 * Roughly one bar's width, floored at 30s: refetching more often than the data can change
 * spends budget for nothing, and refetching much less often shows a chart that silently
 * lags the market. Daily is capped at an hour rather than a day so an evening reload picks
 * up the close.
 */
const FRESH_MS: Readonly<Record<Timeframe, number>> = Object.freeze({
  '1m': 45_000,
  '5m': 150_000,
  '15m': 450_000,
  '1h': 900_000,
  '4h': 1_800_000,
  '1d': 3_600_000,
});

/** Search results move far more slowly than prices. */
const SEARCH_FRESH_MS = 6 * 3_600_000;
/** A quote is the one thing that is supposed to be current. */
const QUOTE_FRESH_MS = 20_000;

export interface CacheStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** `localStorage`, with quota and privacy-mode failures swallowed rather than thrown. */
export function browserCacheStore(prefix = 'tdv-shadow.cache.'): CacheStore {
  return {
    get(key) {
      try {
        return localStorage.getItem(prefix + key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(prefix + key, value);
      } catch {
        // A full quota must not break fetching. The cost is a cache miss next time.
      }
    },
  };
}

/** An in-memory store, for tests and for when persistence is unwanted. */
export function memoryCacheStore(): CacheStore {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
  };
}

interface Envelope<T> {
  readonly at: number;
  readonly value: T;
}

/** A series result that may have come from a stale cache after the provider refused. */
export interface CachedSeries extends SeriesPage {
  /**
   * True when this came from cache after a live fetch failed.
   *
   * The caller is expected to say so. Showing yesterday's bars is right; showing them
   * without a word is how a chart lies about being live.
   */
  readonly stale: boolean;
  /** When the data was actually fetched. */
  readonly fetchedAt: number;
}

export interface CachingOptions {
  readonly store?: CacheStore;
  /** Injected so tests do not wait. Defaults to `Date.now`. */
  readonly now?: () => number;
}

/** Serialised bars, as tuples — smaller in storage and exactly the wire shape §3.2 uses. */
type StoredBar = readonly [number, number, number, number, number, number];

interface StoredSeries {
  readonly bars: readonly StoredBar[];
  readonly dropped: number;
}

export function withCache(
  provider: MarketDataProvider,
  options: CachingOptions = {},
): MarketDataProvider & { seriesFrom(symbol: string, tf: Timeframe, limit: number): Promise<ProviderResult<CachedSeries>> } {
  const store = options.store ?? memoryCacheStore();
  const now = options.now ?? Date.now;
  const id = provider.capabilities().id;

  /** One promise per key while a request is in flight, so duplicates cost nothing. */
  const inFlight = new Map<string, Promise<ProviderResult<unknown>>>();

  const read = <T>(key: string): Envelope<T> | null => {
    const raw = store.get(key);
    if (raw === null) return null;
    try {
      const parsed = JSON.parse(raw) as Envelope<T>;
      // A stored entry from an older schema must be ignored, not trusted.
      return typeof parsed.at === 'number' && 'value' in parsed ? parsed : null;
    } catch {
      return null;
    }
  };

  const write = (key: string, value: unknown): void => {
    try {
      store.set(key, JSON.stringify({ at: now(), value }));
    } catch {
      // Circular or oversized values are not worth taking a fetch down for.
    }
  };

  /**
   * Runs `produce` once per key even if called concurrently.
   *
   * The entry is removed in a `finally`, so a rejected promise cannot wedge the key
   * forever — providers do not reject, but a bug in one must not disable its cache.
   */
  const coalesce = async <T>(
    key: string,
    produce: () => Promise<ProviderResult<T>>,
  ): Promise<ProviderResult<T>> => {
    const existing = inFlight.get(key);
    if (existing !== undefined) return (await existing) as ProviderResult<T>;
    const promise = produce() as Promise<ProviderResult<unknown>>;
    inFlight.set(key, promise);
    try {
      return (await promise) as ProviderResult<T>;
    } finally {
      inFlight.delete(key);
    }
  };

  const seriesFrom = async (
    symbol: string,
    timeframe: Timeframe,
    limit: number,
  ): Promise<ProviderResult<CachedSeries>> => {
    const ticker = symbol.trim().toUpperCase();
    const key = `${id}:series:${ticker}:${timeframe}`;
    const cached = read<StoredSeries>(key);
    const age = cached === null ? Number.POSITIVE_INFINITY : now() - cached.at;

    const revive = (entry: Envelope<StoredSeries>, stale: boolean): ProviderResult<CachedSeries> => {
      const bars = [];
      for (const tuple of entry.value.bars) {
        const bar = makeBar({
          t: tuple[0],
          o: tuple[1],
          h: tuple[2],
          l: tuple[3],
          c: tuple[4],
          v: tuple[5],
        });
        if (bar !== null) bars.push(bar);
      }
      if (bars.length === 0) return fail('format', 'cached series was unusable');
      return ok({ bars, dropped: entry.value.dropped, stale, fetchedAt: entry.at });
    };

    // Fresh enough that asking again would spend budget on the same answer.
    if (cached !== null && age < FRESH_MS[timeframe]) {
      const revived = revive(cached, false);
      if (revived.ok) return revived;
    }

    const result = await coalesce(key, () => provider.fetchSeries(ticker, timeframe, limit));
    if (result.ok) {
      write(
        key,
        {
          bars: result.value.bars.map((b) => [b.t, b.o, b.h, b.l, b.c, b.v]),
          dropped: result.value.dropped,
        } satisfies StoredSeries,
      );
      return ok({ ...result.value, stale: false, fetchedAt: now() });
    }

    /*
     * The live fetch failed and there is something in the cache.
     *
     * Serving it beats an empty chart — but only with `stale` set, so the caller says
     * which. A rate limit at 09:31 with yesterday's close in hand is a usable chart; the
     * same chart presented as live is a lie.
     *
     * `no-key` is excluded: there is no credential, so this is not a transient failure to
     * ride out, and quietly showing cached data would hide that nothing is configured.
     */
    if (cached !== null && result.kind !== 'no-key') {
      const revived = revive(cached, true);
      if (revived.ok) return revived;
    }
    return result;
  };

  return {
    capabilities: (): ProviderCapabilities => provider.capabilities(),

    async fetchSeries(symbol, timeframe, limit) {
      const result = await seriesFrom(symbol, timeframe, limit);
      if (!result.ok) return result;
      return ok({ bars: result.value.bars, dropped: result.value.dropped });
    },

    seriesFrom,

    async searchSymbols(query) {
      const trimmed = query.trim().toLowerCase();
      if (trimmed === '') return ok([]);
      const key = `${id}:search:${trimmed}`;
      const cached = read<readonly SymbolHit[]>(key);
      if (cached !== null && now() - cached.at < SEARCH_FRESH_MS) return ok(cached.value);

      const result = await coalesce(key, () => provider.searchSymbols(trimmed));
      if (result.ok) {
        write(key, result.value);
        return result;
      }
      // Same reasoning as a series: an old hit list is far better than none while
      // rate-limited, and search results do not go wrong the way a price does.
      if (cached !== null && result.kind !== 'no-key') return ok(cached.value);
      return result;
    },

    async fetchQuote(symbol) {
      const ticker = symbol.trim().toUpperCase();
      const key = `${id}:quote:${ticker}`;
      const cached = read<Quote>(key);
      if (cached !== null && now() - cached.at < QUOTE_FRESH_MS) return ok(cached.value);

      const result = await coalesce(key, () => provider.fetchQuote(ticker));
      if (result.ok) write(key, result.value);
      // A stale quote is NOT served on failure. Every other cached thing is history, which
      // does not change; a quote's whole claim is that it is current, and an old one shown
      // as a live price is the one case where cached data is worse than none.
      return result;
    },
  };
}
