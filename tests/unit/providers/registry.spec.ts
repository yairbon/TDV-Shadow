/**
 * The assembled chain.
 *
 * The properties worth holding: a timeframe is offered exactly when some provider can
 * serve it, the chain falls through to bundled data rather than showing nothing, and
 * search merges across providers without duplicating an instrument.
 */

import { describe, expect, it, vi } from 'vitest';
import { createMarketData } from '../../../src/providers/registry.js';
import { fail, ok, type MarketDataProvider } from '../../../src/providers/types.js';
import { makeBar, type Bar, type Timeframe } from '../../../src/data/types.js';

function minuteBars(count: number): Bar[] {
  const out: Bar[] = [];
  const start = Date.UTC(2026, 7, 13, 13, 30, 0);
  for (let i = 0; i < count; i++) {
    const bar = makeBar({ t: start + i * 60_000, o: 100, h: 101, l: 99, c: 100.5, v: 10 });
    if (bar === null) throw new Error('fixture rejected');
    out.push(bar);
  }
  return out;
}

/** A provider that serves exactly the timeframes given, and records what was asked. */
function stub(
  id: 'twelve-data' | 'alpha-vantage' | 'bundled',
  native: readonly Timeframe[],
  options: { ready?: boolean; hits?: readonly { symbol: string; exchange: string }[] } = {},
): { provider: MarketDataProvider; asked: { symbol: string; timeframe: Timeframe }[] } {
  const asked: { symbol: string; timeframe: Timeframe }[] = [];
  return {
    asked,
    provider: {
      capabilities: () => ({
        id,
        label: id,
        nativeTimeframes: native,
        canSearch: true,
        canQuote: true,
        ready: options.ready ?? true,
      }),
      fetchSeries(symbol, timeframe) {
        asked.push({ symbol, timeframe });
        if (!native.includes(timeframe)) return Promise.resolve(fail('entitlement', 'nope'));
        return Promise.resolve(ok({ bars: minuteBars(120), dropped: 0 }));
      },
      searchSymbols() {
        return Promise.resolve(
          ok(
            (options.hits ?? [{ symbol: 'AAPL', exchange: 'NASDAQ' }]).map((hit) => ({
              symbol: hit.symbol,
              name: hit.symbol,
              exchange: hit.exchange,
              currency: 'USD',
              country: 'US',
            })),
          ),
        );
      },
      fetchQuote(symbol) {
        return Promise.resolve(
          ok({ symbol, price: 100, time: 1 as never, marketOpen: true, previousClose: null }),
        );
      },
    },
  };
}

const noPersist = { persist: false as const };

describe('the default chain', () => {
  it('offers every timeframe, because Twelve Data serves them all', () => {
    const market = createMarketData(noPersist);
    const offered = market.timeframes();
    expect(offered).toHaveLength(6);
    for (const entry of offered) {
      expect(entry.origin, entry.timeframe).not.toBe('unavailable');
      expect(entry.provider).toBe('Twelve Data');
    }
  });

  it('always includes bundled data, so an offline build still charts something', () => {
    const ids = createMarketData(noPersist)
      .providers()
      .map((capability) => capability.id);
    expect(ids).toContain('bundled');
  });
});

describe('timeframe availability', () => {
  it('marks a timeframe unavailable with a reason when nothing serves it', () => {
    // Alpha Vantage on a free key, alone: daily works, intraday cannot. `only` is what
    // makes this a real chain of one rather than the stub sitting in front of the
    // built-in providers, which would claim intraday themselves.
    const daily = stub('alpha-vantage', ['1d']);
    const market = createMarketData({ ...noPersist, only: [daily.provider] });
    const offered = market.timeframes();
    expect(offered.find((entry) => entry.timeframe === '1d')?.origin).toBe('native');
    for (const intraday of ['1m', '5m', '1h'] as Timeframe[]) {
      const entry = offered.find((candidate) => candidate.timeframe === intraday);
      expect(entry?.origin, intraday).toBe('unavailable');
      expect(entry?.reason, intraday).not.toBe('');
      expect(entry?.provider).toBeNull();
    }
  });

  it('routes each timeframe to a provider that serves it natively', async () => {
    const intraday = stub('twelve-data', ['1m', '5m']);
    const daily = stub('alpha-vantage', ['1d']);
    const market = createMarketData({
      ...noPersist,
      only: [intraday.provider, daily.provider],
    });
    const result = await market.series('AAPL', '1m', 10);
    expect(intraday.asked.at(-1)).toMatchObject({ timeframe: '1m' });
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.sourceTimeframe).toBe('1m');
  });

  it('resamples when no provider has the timeframe natively', async () => {
    const minute = stub('twelve-data', ['1m']);
    const market = createMarketData({ ...noPersist, only: [minute.provider] });
    const result = await market.series('AAPL', '5m', 10);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.origin).toBe('resampled');
    // It fetched the FINER series, not the one asked for.
    expect(minute.asked.at(-1)?.timeframe).toBe('1m');
    // And it says WHICH one, so the status line can name the source instead of telling
    // the reader their bars were "rolled up from resampled".
    expect(result.value.sourceTimeframe).toBe('1m');
    // 120 one-minute bars roll into 24 five-minute bars.
    expect(result.value.bars.length).toBeLessThan(120);
    expect(result.value.bars.length).toBeGreaterThan(0);
  });

  it('asks for proportionally more bars when it is going to roll them up', async () => {
    // Requesting 100 five-minute bars from a 1m source needs 500 source bars, not 100 —
    // otherwise a full request yields twenty buckets.
    const minute = stub('twelve-data', ['1m']);
    let requested = 0;
    const spy: MarketDataProvider = {
      ...minute.provider,
      fetchSeries(symbol, timeframe, limit) {
        requested = limit;
        return minute.provider.fetchSeries(symbol, timeframe, limit);
      },
    };
    const market = createMarketData({ ...noPersist, only: [spy] });
    await market.series('AAPL', '5m', 100);
    expect(requested).toBe(500);
  });
});

describe('falling through the chain', () => {
  it('asks the next provider when the first one fails', async () => {
    // The chain was a chain in name only: one provider was named and a failure there
    // ended the request, so a momentarily unreachable connector did not fall through to
    // the CSVs sitting behind it — the chart refused to load a symbol it had data for.
    const broken: MarketDataProvider = {
      ...stub('alpha-vantage', ['1d']).provider,
      fetchSeries: () => Promise.resolve(fail('network', 'connector unreachable')),
    };
    const backup = stub('bundled', ['1d']);
    const market = createMarketData({ ...noPersist, only: [broken, backup.provider] });

    const result = await market.series('AAPL', '1d', 10);
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.providerId).toBe('bundled');
    expect(backup.asked).toHaveLength(1);
  });

  it('does not ask a later provider once one has answered', async () => {
    const first = stub('twelve-data', ['1d']);
    const second = stub('bundled', ['1d']);
    const market = createMarketData({ ...noPersist, only: [first.provider, second.provider] });
    await market.series('AAPL', '1d', 10);
    expect(first.asked).toHaveLength(1);
    expect(second.asked).toHaveLength(0);
  });

  it('reports the most specific reason when every provider refuses', async () => {
    const refuse = (reason: string): MarketDataProvider => ({
      ...stub('alpha-vantage', ['1d']).provider,
      fetchSeries: () => Promise.resolve(fail('rate-limit', reason)),
    });
    const market = createMarketData({
      ...noPersist,
      only: [refuse('first ran out'), refuse('second ran out')],
    });
    const result = await market.series('AAPL', '1d', 10);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('ran out');
  });

  it('skips a provider that cannot serve the timeframe at all', async () => {
    const dailyOnly = stub('alpha-vantage', ['1d']);
    const minute = stub('twelve-data', ['1m']);
    const market = createMarketData({ ...noPersist, only: [dailyOnly.provider, minute.provider] });
    await market.series('AAPL', '1m', 10);
    expect(dailyOnly.asked).toHaveLength(0);
    expect(minute.asked).toHaveLength(1);
  });
});

describe('picking the provider', () => {
  it('asks the provider whose capabilities were consulted, not one sharing its id', async () => {
    // An MCP and a REST Alpha Vantage are both `alpha-vantage`. Looking the chosen
    // capability back up by id hands the request to whichever was inserted last, which is
    // a different provider from the one that was resolved against.
    const first = stub('alpha-vantage', ['1d']);
    const second = stub('alpha-vantage', ['1d']);
    const market = createMarketData({ ...noPersist, only: [first.provider, second.provider] });
    await market.series('AAPL', '1d', 10);
    expect(first.asked).toHaveLength(1);
    expect(second.asked).toHaveLength(0);
  });
});

describe('searching across providers', () => {
  it('merges hits and collapses duplicates by symbol and exchange', async () => {
    // Both providers know AAPL@NASDAQ; only one knows TSLA@BMV. One row each.
    const a = stub('twelve-data', ['1m'], {
      hits: [
        { symbol: 'AAPL', exchange: 'NASDAQ' },
        { symbol: 'TSLA', exchange: 'BMV' },
      ],
    });
    const b = stub('alpha-vantage', ['1d'], {
      hits: [
        { symbol: 'AAPL', exchange: 'NASDAQ' },
        { symbol: 'AAPL', exchange: 'XETRA' },
      ],
    });
    const market = createMarketData({ ...noPersist, only: [a.provider, b.provider] });
    const result = await market.search('a');
    if (!result.ok) throw new Error(result.reason);
    const keys = result.value.map((hit) => `${hit.symbol}@${hit.exchange}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('AAPL@NASDAQ');
    expect(keys).toContain('TSLA@BMV');
    expect(keys).toContain('AAPL@XETRA');
  });

  it('keeps the same instrument on two venues apart', async () => {
    // TSLA on NASDAQ and TSLA on BMV are different instruments in different currencies.
    const a = stub('twelve-data', ['1m'], {
      hits: [
        { symbol: 'TSLA', exchange: 'NASDAQ' },
        { symbol: 'TSLA', exchange: 'BMV' },
      ],
    });
    const market = createMarketData({ ...noPersist, only: [a.provider] });
    const result = await market.search('tesla');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.filter((hit) => hit.symbol === 'TSLA')).toHaveLength(2);
  });

  it('does not ask a provider that has no credential', async () => {
    // Not just wasted effort. Its refusal is a failure like any other, so it becomes the
    // reason reported when nothing matched — and "add a key for Alpha Vantage" is the
    // wrong thing to tell someone whose Twelve Data credits ran out.
    const unready = stub('alpha-vantage', ['1d'], { ready: false });
    const limited: MarketDataProvider = {
      ...stub('twelve-data', ['1m']).provider,
      searchSymbols: () => Promise.resolve(fail('rate-limit', 'API credits exceeded')),
    };
    const market = createMarketData({ ...noPersist, only: [limited, unready.provider] });
    const result = await market.search('anything');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('credits');
  });

  it('does not let one unreachable provider stall the whole search', async () => {
    // `Promise.all` waits for the slowest, so a provider blocked by a firewall or an
    // extension held the dialog on "searching…" indefinitely while hits that had already
    // arrived sat unrendered.
    vi.useFakeTimers();
    try {
      const answering = stub('twelve-data', ['1m'], { hits: [{ symbol: 'TSM', exchange: 'NYSE' }] });
      const silent: MarketDataProvider = {
        ...stub('alpha-vantage', ['1d']).provider,
        searchSymbols: () => new Promise(() => {}),
      };
      const market = createMarketData({
        ...noPersist,
        only: [silent, answering.provider],
      });
      const pending = market.search('semi');
      await vi.advanceTimersByTimeAsync(5000);
      const result = await pending;
      if (!result.ok) throw new Error(result.reason);
      expect(result.value.map((hit) => hit.symbol)).toContain('TSM');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not call out for an empty query', async () => {
    const result = await createMarketData(noPersist).search('   ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([]);
  });
});

describe('quoting', () => {
  it('skips a provider that cannot quote', () => {
    // The bundled provider has no live price and says so; asking it would return a
    // months-old close dressed as a quote.
    const market = createMarketData(noPersist);
    const bundled = market.providers().find((capability) => capability.id === 'bundled');
    expect(bundled?.canQuote).toBe(false);
  });

  it('takes the first provider that answers', async () => {
    const first = stub('twelve-data', ['1m']);
    const market = createMarketData({ ...noPersist, only: [first.provider] });
    const result = await market.quote('AAPL');
    if (!result.ok) throw new Error(result.reason);
    expect(result.value.symbol).toBe('AAPL');
  });
});
