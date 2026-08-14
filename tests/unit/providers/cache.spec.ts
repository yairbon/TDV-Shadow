/**
 * The caching decorator.
 *
 * What makes this worth testing carefully is that its failures are invisible: a cache that
 * never hits still shows correct charts, right up until the daily budget runs out and the
 * app is locked out for hours. So the assertions are about how many times the underlying
 * provider was actually called, not just about what came back.
 */

import { describe, expect, it } from 'vitest';
import { memoryCacheStore, withCache } from '../../../src/providers/cache.js';
import { fail, ok, type MarketDataProvider, type ProviderResult } from '../../../src/providers/types.js';
import { makeBar, type Bar, type Timeframe } from '../../../src/data/types.js';

function bars(count: number, startMs = Date.UTC(2026, 7, 13, 0, 0, 0)): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < count; i++) {
    const bar = makeBar({ t: startMs + i * 60_000, o: 100, h: 101, l: 99, c: 100.5, v: 10 });
    if (bar === null) throw new Error('fixture bar rejected');
    out.push(bar);
  }
  return out;
}

interface Counting {
  readonly provider: MarketDataProvider;
  readonly calls: { series: number; search: number; quote: number };
  answer: ProviderResult<never> | null;
  /** Resolves pending series calls, for the coalescing test. */
  release: (() => void) | null;
}

function counting(options: { defer?: boolean } = {}): Counting {
  const state: Counting = {
    calls: { series: 0, search: 0, quote: 0 },
    answer: null,
    release: null,
    provider: {
      capabilities: () => ({
        id: 'twelve-data',
        label: 'test',
        nativeTimeframes: ['1m', '1d'] as readonly Timeframe[],
        canSearch: true,
        canQuote: true,
        ready: true,
      }),
      async fetchSeries() {
        state.calls.series++;
        if (options.defer === true) {
          await new Promise<void>((resolve) => {
            state.release = resolve;
          });
        }
        return state.answer ?? ok({ bars: bars(3), dropped: 0 });
      },
      searchSymbols() {
        state.calls.search++;
        return Promise.resolve(
          state.answer ??
            ok([{ symbol: 'AAPL', name: 'Apple', exchange: 'NASDAQ', currency: 'USD', country: 'US' }]),
        );
      },
      fetchQuote() {
        state.calls.quote++;
        return Promise.resolve(
          state.answer ?? ok({ symbol: 'AAPL', price: 100, time: 1 as never, marketOpen: true }),
        );
      },
    } as unknown as MarketDataProvider,
  };
  return state;
}

describe('serving from cache', () => {
  it('asks the provider once for a repeated request', async () => {
    // The behaviour the daily budget depends on.
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    await cached.fetchSeries('AAPL', '1m', 100);
    await cached.fetchSeries('AAPL', '1m', 100);
    await cached.fetchSeries('AAPL', '1m', 100);
    expect(inner.calls.series).toBe(1);
  });

  it('keeps symbols and timeframes apart', async () => {
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    await cached.fetchSeries('AAPL', '1m', 100);
    await cached.fetchSeries('AAPL', '1d', 100);
    await cached.fetchSeries('MSFT', '1m', 100);
    expect(inner.calls.series).toBe(3);
  });

  it('refetches once the entry is older than its timeframe allows', async () => {
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, {
      store: memoryCacheStore(),
      now: () => clock,
    });
    await cached.fetchSeries('AAPL', '1m', 100);
    clock += 30_000; // under the 45s freshness for 1m
    await cached.fetchSeries('AAPL', '1m', 100);
    expect(inner.calls.series).toBe(1);
    clock += 30_000; // now past it
    await cached.fetchSeries('AAPL', '1m', 100);
    expect(inner.calls.series).toBe(2);
  });

  it('holds a daily series far longer than a minute series', async () => {
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => clock });
    await cached.fetchSeries('AAPL', '1d', 100);
    clock += 10 * 60_000; // ten minutes: a 1m entry would be long gone
    await cached.fetchSeries('AAPL', '1d', 100);
    expect(inner.calls.series).toBe(1);
  });

  it('returns bars that survive the round trip through storage', async () => {
    const clock = 1_000_000;
    const inner = counting();
    const store = memoryCacheStore();
    const cached = withCache(inner.provider, { store, now: () => clock });
    const first = await cached.fetchSeries('AAPL', '1m', 100);
    if (!first.ok) throw new Error(first.reason);

    // A fresh decorator over the same store: exactly what a page reload looks like.
    const reloaded = withCache(counting().provider, { store, now: () => clock });
    const second = await reloaded.fetchSeries('AAPL', '1m', 100);
    if (!second.ok) throw new Error(second.reason);
    expect(second.value.bars.map((b) => [b.t, b.c])).toEqual(
      first.value.bars.map((b) => [b.t, b.c]),
    );
    for (const bar of second.value.bars) expect(Object.isFrozen(bar)).toBe(true);
  });
});

describe('coalescing', () => {
  it('makes one request for concurrent identical asks', async () => {
    // A symbol change racing a timeframe change is the real case; both fire at once.
    const inner = counting({ defer: true });
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    const a = cached.fetchSeries('AAPL', '1m', 100);
    const b = cached.fetchSeries('AAPL', '1m', 100);
    const c = cached.fetchSeries('AAPL', '1m', 100);
    // Let the provider reach its await.
    await Promise.resolve();
    inner.release?.();
    const results = await Promise.all([a, b, c]);
    expect(inner.calls.series).toBe(1);
    for (const result of results) expect(result.ok).toBe(true);
  });

  it('frees the key afterwards, so a later request is not blocked', async () => {
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => 0 });
    await cached.fetchSeries('AAPL', '1m', 100);
    // Different key, so the cache does not answer it; the first must not have wedged.
    await cached.fetchSeries('MSFT', '1m', 100);
    expect(inner.calls.series).toBe(2);
  });
});

describe('falling back to stale data', () => {
  it('serves the cached series when the provider is rate-limited, and says it is stale', async () => {
    // A rate limit at 09:31 with yesterday's close in hand is a usable chart. The same
    // chart presented as current is a lie, which is what `stale` exists to prevent.
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => clock });
    const fresh = await cached.seriesFrom('AAPL', '1m', 100);
    if (!fresh.ok) throw new Error(fresh.reason);
    expect(fresh.value.stale).toBe(false);

    clock += 10 * 60_000;
    inner.answer = fail('rate-limit', 'too many requests');
    const stale = await cached.seriesFrom('AAPL', '1m', 100);
    if (!stale.ok) throw new Error(stale.reason);
    expect(stale.value.stale).toBe(true);
    expect(stale.value.bars).toHaveLength(3);
    expect(stale.value.fetchedAt).toBe(1_000_000);
  });

  it('does not hide a missing key behind cached data', async () => {
    // Nothing is configured; serving old bars would make that look like it works.
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => clock });
    await cached.seriesFrom('AAPL', '1m', 100);
    clock += 10 * 60_000;
    inner.answer = fail('no-key', 'no key');
    const result = await cached.seriesFrom('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('no-key');
  });

  it('passes the failure through when there is nothing cached', async () => {
    const inner = counting();
    inner.answer = fail('rate-limit', 'too many requests');
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    const result = await cached.seriesFrom('AAPL', '1m', 100);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('rate-limit');
  });

  it('never serves a stale QUOTE', async () => {
    // Every other cached thing is history, which does not change. A quote's only claim is
    // that it is current, so an old one shown as a live price is worse than none.
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => clock });
    await cached.fetchQuote('AAPL');
    clock += 10 * 60_000;
    inner.answer = fail('rate-limit', 'too many requests');
    const result = await cached.fetchQuote('AAPL');
    expect(result.ok).toBe(false);
  });

  it('serves a fresh quote from cache, though', async () => {
    let clock = 1_000_000;
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore(), now: () => clock });
    await cached.fetchQuote('AAPL');
    clock += 5_000;
    await cached.fetchQuote('AAPL');
    expect(inner.calls.quote).toBe(1);
  });
});

describe('robustness', () => {
  it('ignores a corrupt cache entry rather than failing the fetch', async () => {
    const store = memoryCacheStore();
    store.set('twelve-data:series:AAPL:1m', 'not json at all');
    const inner = counting();
    const cached = withCache(inner.provider, { store });
    const result = await cached.fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(true);
    expect(inner.calls.series).toBe(1);
  });

  it('survives a store that throws on write, as a full quota does', async () => {
    const store = {
      get: () => null,
      set: () => {
        throw new Error('QuotaExceededError');
      },
    };
    const inner = counting();
    const cached = withCache(inner.provider, { store });
    const result = await cached.fetchSeries('AAPL', '1m', 100);
    expect(result.ok).toBe(true);
  });

  it('caches searches case-insensitively', async () => {
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    await cached.searchSymbols('Tesla');
    await cached.searchSymbols('tesla');
    await cached.searchSymbols('  TESLA  ');
    expect(inner.calls.search).toBe(1);
  });

  it('passes capabilities straight through', () => {
    const inner = counting();
    const cached = withCache(inner.provider, { store: memoryCacheStore() });
    expect(cached.capabilities()).toEqual(inner.provider.capabilities());
  });
});
