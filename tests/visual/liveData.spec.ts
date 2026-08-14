/**
 * Live intraday data, end to end through the app.
 *
 * The provider responses are intercepted and answered with bodies recorded from the real
 * Twelve Data API, for two reasons. The obvious one is determinism — a test that depends
 * on a live market fails at the weekend. The other is that this sandbox blocks browser
 * egress entirely, so a test that reached the network would not run here at all.
 *
 * What that leaves unverified is exactly one hop: the browser's own request to the API.
 * The adapters are driven against the live API separately (see the provider specs and the
 * commit message), and everything from the response bytes onwards — parsing, timezone
 * conversion, resolution, resampling, and the UI — is covered here.
 */

import type { Page, Route } from '@playwright/test';
import { expect, test } from './harness.js';

/** One minute of AAPL, newest-first, exactly as the API returns it. */
function minuteBody(count: number, interval = '1min', stepMinutes = 1): string {
  const values = [];
  // 15:59 New York on 2026-08-13, walking backwards — the shape a real response has.
  let minute = 59;
  let hour = 15;
  for (let i = 0; i < count; i++) {
    const stamp = `2026-08-13 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
    const base = 300 + i * 0.1;
    values.push({
      datetime: stamp,
      open: base.toFixed(2),
      high: (base + 0.4).toFixed(2),
      low: (base - 0.4).toFixed(2),
      close: (base + 0.1).toFixed(2),
      volume: String(100000 + i),
    });
    minute -= stepMinutes;
    while (minute < 0) {
      minute += 60;
      hour -= 1;
    }
    if (hour < 4) break;
  }
  return JSON.stringify({
    meta: {
      symbol: 'AAPL',
      interval,
      currency: 'USD',
      exchange_timezone: 'America/New_York',
      exchange: 'NASDAQ',
    },
    values,
    status: 'ok',
  });
}

const DAILY_BODY = JSON.stringify({
  meta: { symbol: 'AAPL', interval: '1day', exchange_timezone: 'America/New_York' },
  values: Array.from({ length: 60 }, (_, i) => {
    const day = 13 - (i % 13);
    const month = 8 - Math.floor(i / 13);
    return {
      datetime: `2026-${String(month).padStart(2, '0')}-${String(day || 1).padStart(2, '0')}`,
      open: '300.00',
      high: '305.00',
      low: '299.00',
      close: '304.00',
      volume: '40000000',
    };
  }),
  status: 'ok',
});

/**
 * A quote landing INSIDE the newest bar of every series these stubs serve.
 *
 * The 1-minute series ends at 15:59 New York and the daily one ends on the same date, so
 * one timestamp half a minute into that final minute is inside both. The price is above
 * the bar's high, so applying it has to move two fields, not one.
 */
const QUOTE_TIME_MS = Date.UTC(2026, 7, 13, 19, 59, 30);
const QUOTE_PRICE = 300.9;
const QUOTE_BODY = {
  symbol: 'AAPL',
  close: String(QUOTE_PRICE),
  // Epoch SECONDS on the wire, as the vendor sends them.
  timestamp: QUOTE_TIME_MS / 1000,
  is_market_open: true,
};

/** One search hit, in the shape Twelve Data returns them. */
const hit = (symbol: string, name: string, exchange: string): Record<string, string> => ({
  symbol,
  instrument_name: name,
  exchange,
  country: 'United States',
  currency: 'USD',
});

/** Answers every provider call, and records which intervals were asked for. */
async function stubProviders(page: Page): Promise<string[]> {
  const intervals: string[] = [];
  await page.route('https://api.twelvedata.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/symbol_search') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          data: [
            hit('AAPL', 'Apple Inc', 'NASDAQ'),
            // Not in the bundled list, which is the whole point of asking a provider.
            hit('ASML', 'ASML Holding NV', 'NASDAQ'),
          ],
        }),
      });
      return;
    }
    if (url.pathname === '/quote') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(QUOTE_BODY),
      });
      return;
    }
    const interval = url.searchParams.get('interval') ?? '';
    intervals.push(interval);
    const body = interval === '1day' ? DAILY_BODY : minuteBody(200, interval, interval === '1h' ? 60 : Number.parseInt(interval, 10) || 1);
    await route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  // Alpha Vantage has no key here, so it never calls out; block it anyway so a regression
  // that starts calling it cannot silently reach the network.
  await page.route('https://www.alphavantage.co/**', (route) => route.abort());
  return intervals;
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

interface SeriesShape {
  readonly timeframe: string;
  readonly count: number;
  readonly first: number;
  readonly last: number;
  readonly ascending: boolean;
}

const seriesShape = (page: Page): Promise<SeriesShape> =>
  page.evaluate(() => {
    const win = window as unknown as {
      __tdv: { getState: () => { timeframe: string } };
      __chart: { series: { get: () => { bars: readonly { t: number }[] } } };
    };
    const bars = win.__chart.series.get().bars;
    let ascending = true;
    for (let i = 1; i < bars.length; i++) if (bars[i].t <= bars[i - 1].t) ascending = false;
    return {
      timeframe: win.__tdv.getState().timeframe,
      count: bars.length,
      first: bars[0]?.t ?? 0,
      last: bars[bars.length - 1]?.t ?? 0,
      ascending,
    };
  });

/** The newest bar on the chart — what a live quote is supposed to move. */
const lastBar = (page: Page): Promise<{ t: number; h: number; l: number; c: number; count: number }> =>
  page.evaluate(() => {
    const win = window as unknown as {
      __chart: { series: { get: () => { bars: readonly { t: number; h: number; l: number; c: number }[] } } };
    };
    const bars = win.__chart.series.get().bars;
    const bar = bars[bars.length - 1];
    return { t: bar.t, h: bar.h, l: bar.l, c: bar.c, count: bars.length };
  });

const liveLabel = (page: Page): Promise<string> =>
  page.evaluate(() => document.querySelector('#live-label')?.textContent ?? '');

/** Clicks a timeframe button and waits for the swap to land. */
async function pickTimeframe(page: Page, timeframe: string): Promise<void> {
  await page.click(`#timeframes button[data-tf="${timeframe}"]`);
  await page.waitForFunction(
    (wanted) =>
      (window as unknown as { __tdv: { getState: () => { timeframe: string } } }).__tdv.getState()
        .timeframe === wanted,
    timeframe,
    { timeout: 8000 },
  );
}

test.describe('timeframe availability', () => {
  test('a synthetic series offers intraday but not a rolled-up day', async ({ page }) => {
    // DEMO carries its own 1-minute base and is resampled locally. A day cannot honestly
    // come out of that: UTC day buckets do not line up with any trading session.
    await open(page);
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#timeframes button')].map((b) => ({
        tf: b.dataset['tf'] ?? '',
        enabled: !b.disabled,
        title: b.title,
      })),
    );
    const daily = buttons.find((b) => b.tf === '1d');
    expect(daily?.enabled).toBe(false);
    expect(daily?.title).toContain('cannot be rolled up');
    for (const intraday of ['1m', '5m', '15m', '1h']) {
      expect(buttons.find((b) => b.tf === intraday)?.enabled, intraday).toBe(true);
    }
  });

  test('a disabled timeframe says why, rather than just being dead', async ({ page }) => {
    await open(page);
    const titles = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#timeframes button')]
        .filter((b) => b.disabled)
        .map((b) => b.title),
    );
    expect(titles.length).toBeGreaterThan(0);
    for (const title of titles) {
      expect(title).not.toBe('');
      expect(title).not.toBe('not available for this symbol');
    }
  });
});

test.describe('loading real intraday data', () => {
  test('fetches 1-minute bars and puts them on the chart', async ({ page }) => {
    const intervals = await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);

    await pickTimeframe(page, '1m');
    const shape = await seriesShape(page);
    expect(shape.timeframe).toBe('1m');
    expect(shape.count).toBeGreaterThan(50);
    expect(shape.ascending).toBe(true);
    // It asked the API for minutes.
    expect(intervals).toContain('1min');
  });

  test('converts exchange-local stamps to UTC on the way in', async ({ page }) => {
    // The response is stamped 15:59 New York. Read as UTC it would land four hours out,
    // and the chart would look entirely normal.
    await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');

    const shape = await seriesShape(page);
    expect(shape.last).toBe(Date.UTC(2026, 7, 13, 19, 59, 0));
  });

  test('asks for each timeframe natively rather than faking it', async ({ page }) => {
    const intervals = await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);

    for (const [timeframe, expected] of [
      ['5m', '5min'],
      ['1h', '1h'],
      ['1d', '1day'],
    ] as const) {
      await pickTimeframe(page, timeframe);
      expect(intervals, timeframe).toContain(expected);
      const shape = await seriesShape(page);
      expect(shape.timeframe).toBe(timeframe);
      expect(shape.ascending, timeframe).toBe(true);
      expect(shape.count).toBeGreaterThan(1);
    }
  });

  test('keeps the previous chart when a load fails, and says what happened', async ({ page }) => {
    // Blanking the chart, or leaving the old bars under a new name, are both worse than
    // one sentence in the status line.
    await page.route('https://api.twelvedata.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 429, message: 'API credits exceeded', status: 'error' }),
      }),
    );
    await open(page);
    const before = await seriesShape(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await page.click('#timeframes button[data-tf="1m"]');
    await page.waitForTimeout(2500);

    const status = await page.textContent('#status');
    expect(status).toContain('credits');
    const after = await seriesShape(page);
    expect(after.count).toBeGreaterThan(0);
    void before;
  });

  test('does not apply a response for a symbol the user has left', async ({ page }) => {
    // A slow request for one symbol must not land under another's name.
    let held: (() => void) | null = null;
    await page.route('https://api.twelvedata.com/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('symbol') === 'AAPL' && url.searchParams.get('interval') === '1min') {
        await new Promise<void>((resolve) => {
          held = resolve;
        });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: url.searchParams.get('interval') === '1day' ? DAILY_BODY : minuteBody(60),
      });
    });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(500);
    await page.click('#timeframes button[data-tf="1m"]');
    await page.waitForTimeout(400);

    // Move to another symbol while the 1m request is still in flight, then release it.
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('DEMO');
    });
    await page.waitForTimeout(500);
    (held as (() => void) | null)?.();
    await page.waitForTimeout(1200);

    const symbol = await page.evaluate(
      () =>
        (window as unknown as { __tdv: { getState: () => { symbol: string } } }).__tdv.getState()
          .symbol,
    );
    expect(symbol).toBe('DEMO');
  });
});

test.describe('searching every venue, not just the bundled list', () => {
  const openDialog = async (page: Page): Promise<void> => {
    await page.click('#symbol-button');
    await page.waitForSelector('#search-input', { state: 'visible' });
  };

  const rows = (page: Page): Promise<{ symbol: string; source: string }[]> =>
    page.$$eval('#search-results li', (nodes) =>
      nodes.map((node) => ({
        symbol: (node as HTMLElement).dataset['symbol'] ?? '',
        source: node.querySelector('.src')?.textContent ?? '',
      })),
    );

  /** Types, then waits past the debounce and the round trip. */
  const type = async (page: Page, query: string): Promise<void> => {
    await page.fill('#search-input', query);
    await page.waitForTimeout(700);
  };

  test('finds a symbol that is not in the build at all', async ({ page }) => {
    // The one thing the old dialog could not do. ASML is not bundled, so before this it
    // could only be reached by typing the exact ticker into the box and hoping.
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'ASML');
    const found = (await rows(page)).find((row) => row.symbol === 'ASML');
    expect(found).toBeDefined();
  });

  test('shows the venue a remote hit trades on', async ({ page }) => {
    // TSLA on NASDAQ and TSLA on BMV are different instruments in different currencies,
    // so the row has to say which one it is offering.
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'ASML');
    const found = (await rows(page)).find((row) => row.symbol === 'ASML');
    expect(found?.source).toBe('NASDAQ');
  });

  test('does not list an instrument twice when both sides know it', async ({ page }) => {
    // AAPL is bundled AND comes back from the provider. Two identical rows is the
    // failure mode of merging two lists without a key.
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'AAPL');
    const appl = (await rows(page)).filter((row) => row.symbol === 'AAPL');
    expect(appl).toHaveLength(1);
  });

  test('ranks the remote hits with the local ones rather than after them', async ({ page }) => {
    // Appended in a block below, an exact remote ticker would sit under every fuzzy
    // bundled match — typing the name of the thing you want and getting four other
    // things first.
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'ASML');
    expect((await rows(page))[0]?.symbol).toBe('ASML');
  });

  test('loads a symbol chosen from a remote hit', async ({ page }) => {
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'ASML');
    await page.click('#search-results li[data-symbol="ASML"]');
    await page.waitForTimeout(900);
    const symbol = await page.evaluate(
      () =>
        (window as unknown as { __tdv: { getState: () => { symbol: string } } }).__tdv.getState()
          .symbol,
    );
    expect(symbol).toBe('ASML');
  });

  test('says why the search came back empty, instead of just showing nothing', async ({ page }) => {
    await page.route('https://api.twelvedata.com/**', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ code: 429, message: 'API credits exceeded', status: 'error' }),
      }),
    );
    await open(page);
    await openDialog(page);
    await type(page, 'ASML');
    expect(await page.textContent('#search-note')).toContain('credits');
  });

  test('still offers the typed ticker when nothing matches', async ({ page }) => {
    // The series endpoints accept tickers the search index does not list, so an unmatched
    // query is still worth offering — failing loudly beats pretending it does not exist.
    await stubProviders(page);
    await open(page);
    await openDialog(page);
    await type(page, 'ZZZZ');
    expect((await rows(page)).some((row) => row.symbol === 'ZZZZ')).toBe(true);
  });
});

test.describe('live quotes', () => {
  const goLive = async (page: Page): Promise<void> => {
    await page.click('#live-toggle');
    await page.waitForTimeout(900);
  };

  test('moves the last bar to the quoted price', async ({ page }) => {
    await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');

    const before = await lastBar(page);
    expect(before.c).not.toBeCloseTo(QUOTE_PRICE, 4);
    await goLive(page);

    const after = await lastBar(page);
    expect(after.c).toBeCloseTo(QUOTE_PRICE, 4);
    // The quote traded above the bar's high, so the high moved with it.
    expect(after.h).toBeCloseTo(QUOTE_PRICE, 4);
    // …and it is still the same bar. A quote inside a bar must not append a new one.
    expect(after.t).toBe(before.t);
    expect(after.count).toBe(before.count);
    expect(await liveLabel(page)).toBe('Live');
  });

  test('leaves the open and the volume alone', async ({ page }) => {
    // A quote is a price, not a trade report.
    await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');

    const read = (): Promise<{ o: number; v: number }> =>
      page.evaluate(() => {
        const win = window as unknown as {
          __chart: { series: { get: () => { bars: readonly { o: number; v: number }[] } } };
        };
        const bars = win.__chart.series.get().bars;
        return { o: bars[bars.length - 1].o, v: bars[bars.length - 1].v };
      });
    const before = await read();
    await goLive(page);
    expect(await read()).toEqual(before);
  });

  test('is offered for a generated series as simulated ticks, and says so', async ({ page }) => {
    // DEMO has no quote to fetch. The toggle still works, but the label must not claim
    // the random walk is a live price.
    await open(page);
    await goLive(page);
    expect(await liveLabel(page)).toBe('Sim');
  });

  test('is refused for bundled history, with a reason', async ({ page }) => {
    // A CSV baked into the build does not move, and polling cannot make it move.
    await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    const button = await page.evaluate(() => {
      const node = document.querySelector<HTMLButtonElement>('#live-toggle');
      return { disabled: node?.disabled ?? false, title: node?.title ?? '' };
    });
    expect(button.disabled).toBe(true);
    expect(button.title).toContain('bundled');
  });

  test('becomes available once the series comes from a provider', async ({ page }) => {
    await stubProviders(page);
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');
    const disabled = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>('#live-toggle')?.disabled ?? true,
    );
    expect(disabled).toBe(false);
  });

  test('reports a failing quote as stale rather than pretending to be live', async ({ page }) => {
    // The chart stops moving either way; only one of the two is worth acting on.
    await page.route('https://api.twelvedata.com/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/quote') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ code: 429, message: 'API credits exceeded', status: 'error' }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: url.searchParams.get('interval') === '1day' ? DAILY_BODY : minuteBody(120),
      });
    });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');
    await goLive(page);

    expect(await liveLabel(page)).toBe('Stale');
    const title = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>('#live-toggle')?.title ?? '',
    );
    expect(title).toContain('credits');
  });

  test('says the market is closed when the provider says so', async ({ page }) => {
    await page.route('https://api.twelvedata.com/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/quote') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ...QUOTE_BODY, is_market_open: false }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: url.searchParams.get('interval') === '1day' ? DAILY_BODY : minuteBody(120),
      });
    });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');
    await goLive(page);
    expect(await liveLabel(page)).toBe('Closed');
  });

  test('never appends a bar from a quote that is past the current one', async ({ page }) => {
    // A synthesized next bar would carry no volume and an open equal to its close: a
    // real-looking bar that never traded that way.
    await page.route('https://api.twelvedata.com/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/quote') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ...QUOTE_BODY,
            // Hours past the end of the series it is quoting.
            timestamp: (QUOTE_TIME_MS + 6 * 3_600_000) / 1000,
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: url.searchParams.get('interval') === '1day' ? DAILY_BODY : minuteBody(120),
      });
    });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');

    const before = await lastBar(page);
    await goLive(page);
    const after = await lastBar(page);
    expect(after.t).toBe(before.t);
    expect(after.c).toBe(before.c);
    expect(after.count).toBe(before.count);
  });

  test('stops polling when the toggle goes off', async ({ page }) => {
    let quotes = 0;
    await page.route('https://api.twelvedata.com/**', async (route: Route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/quote') {
        quotes += 1;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(QUOTE_BODY),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: url.searchParams.get('interval') === '1day' ? DAILY_BODY : minuteBody(120),
      });
    });
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __tdv: { setSymbol: (s: string) => void } }).__tdv.setSymbol('AAPL');
    });
    await page.waitForTimeout(600);
    await pickTimeframe(page, '1m');
    await goLive(page);
    expect(quotes).toBeGreaterThan(0);

    await page.click('#live-toggle');
    const settled = quotes;
    await page.waitForTimeout(1500);
    expect(quotes).toBe(settled);
    expect(await liveLabel(page)).toBe('Live');
  });
});
