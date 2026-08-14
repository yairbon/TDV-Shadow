/**
 * Yahoo Finance through the proxy, end to end in the app.
 *
 * The route is stubbed rather than live for the usual reason — a test that depends on a
 * real market fails at the weekend — but note what is NOT being worked around here: this
 * path was also driven against the real endpoint in a real browser, because the proxy makes
 * the browser's request same-origin and the dev server does the outbound call. That is the
 * one hop every other provider's tests cannot reach from this sandbox.
 *
 * The build under test is `vite preview`, which serves no proxy, so `?yahoo=1` is the
 * switch that puts the provider in the chain. That is the same switch a reader would use to
 * serve a build behind their own proxy.
 */

import type { Page, Route } from '@playwright/test';
import { expect, test } from './harness.js';

const OPEN = 1786714200;

/** A chart payload in Yahoo's shape, with the two rows a naive reader would keep. */
function chart(count: number, stepSeconds: number): string {
  const timestamp: number[] = [];
  const open: (number | null)[] = [];
  const high: (number | null)[] = [];
  const low: (number | null)[] = [];
  const close: (number | null)[] = [];
  const volume: (number | null)[] = [];
  for (let i = 0; i < count; i++) {
    timestamp.push(OPEN + i * stepSeconds);
    // One untraded slot, which arrives as nulls across the OHLC.
    const quiet = i === 2;
    open.push(quiet ? null : 100 + i * 0.1);
    high.push(quiet ? null : 100.4 + i * 0.1);
    low.push(quiet ? null : 99.6 + i * 0.1);
    close.push(quiet ? null : 100.1 + i * 0.1);
    volume.push(quiet ? null : 1000 + i);
  }
  // The live-quote row Yahoo appends: stamped with a precise trade time, not a bar open.
  const liveAt = OPEN + count * stepSeconds + 23;
  timestamp.push(liveAt);
  open.push(123.45);
  high.push(123.45);
  low.push(123.45);
  close.push(123.45);
  volume.push(0);

  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            symbol: 'PLTR',
            exchangeTimezoneName: 'America/New_York',
            regularMarketTime: liveAt,
            regularMarketPrice: 123.45,
            currentTradingPeriod: { regular: { start: OPEN, end: OPEN + 23_400 } },
          },
          timestamp,
          indicators: { quote: [{ open, high, low, close, volume }] },
        },
      ],
      error: null,
    },
  });
}

const SEARCH = JSON.stringify({
  quotes: [
    { symbol: 'PLTR', longname: 'Palantir Technologies Inc.', exchDisp: 'NASDAQ', quoteType: 'EQUITY' },
    { symbol: 'ES=F', shortname: 'E-Mini S&P', exchDisp: 'CME', quoteType: 'FUTURE' },
  ],
});

const STEP: Readonly<Record<string, number>> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86_400 };

/** Answers the proxy route, and records the intervals asked for. */
async function stubYahoo(page: Page): Promise<string[]> {
  const intervals: string[] = [];
  await page.route('**/yahoo/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/finance/search')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: SEARCH });
      return;
    }
    const interval = url.searchParams.get('interval') ?? '1d';
    intervals.push(interval);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: chart(120, STEP[interval] ?? 86_400),
    });
  });
  // Nothing else may be reached; a request that escapes to a keyed vendor is the bug.
  await page.route('https://api.twelvedata.com/**', (route) => route.abort());
  await page.route('https://www.alphavantage.co/**', (route) => route.abort());
  return intervals;
}

async function open(page: Page): Promise<void> {
  await page.goto('/?yahoo=1');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.goto('/?yahoo=1');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

const load = async (page: Page, ticker: string): Promise<void> => {
  await page.evaluate((t) => {
    const input = document.querySelector<HTMLInputElement>('#symbol-input');
    if (input !== null) input.value = t;
    document.querySelector<HTMLButtonElement>('#symbol-load')?.click();
  }, ticker);
  await page.waitForTimeout(900);
};

const seriesInfo = (page: Page): Promise<{ tf: string; count: number; aligned: boolean }> =>
  page.evaluate(() => {
    const win = window as unknown as {
      __tdv: { getState: () => { timeframe: string } };
      __chart: { series: { get: () => { bars: readonly { t: number }[] } } };
    };
    const bars = win.__chart.series.get().bars;
    const tf = win.__tdv.getState().timeframe;
    const step = { '1m': 60_000, '5m': 300_000, '15m': 900_000, '1h': 3_600_000 }[tf];
    // Every bar must share one phase on the interval lattice. NOT "t % step === 0": a US
    // session opens at 13:30 UTC, so hourly bars legitimately sit on the half hour and an
    // absolute-alignment check would call a correct series broken. What this does catch is
    // the row Yahoo appends 23 seconds past a boundary, which has a phase of its own.
    const phase = bars.length === 0 || step === undefined ? 0 : bars[0].t % step;
    return {
      tf,
      count: bars.length,
      aligned: step === undefined ? true : bars.every((bar) => bar.t % step === phase),
    };
  });

test.describe('Yahoo Finance behind the proxy', () => {
  test('offers every timeframe, because Yahoo serves them all natively', async ({ page }) => {
    // The point of the whole exercise: no key, and 1m through 1d all available.
    await stubYahoo(page);
    await open(page);
    await load(page, 'PLTR');
    const buttons = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#timeframes button')].map((b) => ({
        tf: b.dataset['tf'] ?? '',
        enabled: !b.disabled,
      })),
    );
    for (const button of buttons) expect(button.enabled, button.tf).toBe(true);
  });

  test('loads a symbol that is neither bundled nor on anyone’s demo key', async ({ page }) => {
    await stubYahoo(page);
    await open(page);
    await load(page, 'PLTR');
    const symbol = await page.evaluate(
      () =>
        (window as unknown as { __tdv: { getState: () => { symbol: string } } }).__tdv.getState()
          .symbol,
    );
    expect(symbol).toBe('PLTR');
    expect(await page.textContent('#legend')).toContain('Yahoo Finance');
  });

  test('fetches each intraday timeframe natively rather than rolling it up', async ({ page }) => {
    const intervals = await stubYahoo(page);
    await open(page);
    await load(page, 'PLTR');
    for (const [timeframe, wire] of [
      ['1m', '1m'],
      ['5m', '5m'],
      ['15m', '15m'],
      ['1h', '1h'],
    ] as const) {
      await page.click(`#timeframes button[data-tf="${timeframe}"]`);
      await page.waitForFunction(
        (wanted) =>
          (window as unknown as { __tdv: { getState: () => { timeframe: string } } }).__tdv.getState()
            .timeframe === wanted,
        timeframe,
        { timeout: 8000 },
      );
      expect(intervals, timeframe).toContain(wire);
      const info = await seriesInfo(page);
      expect(info.count, timeframe).toBeGreaterThan(1);
      // The live-quote row Yahoo appends sits 23 seconds past a boundary. Kept, it would
      // put a misaligned bar open at the end of every intraday series.
      expect(info.aligned, timeframe).toBe(true);
    }
  });

  test('drops the untraded slot rather than charting it as a zero', async ({ page }) => {
    await stubYahoo(page);
    await open(page);
    await load(page, 'PLTR');
    await page.click('#timeframes button[data-tf="1m"]');
    await page.waitForTimeout(1200);
    const lows = await page.evaluate(() =>
      (
        window as unknown as {
          __chart: { series: { get: () => { bars: readonly { l: number }[] } } };
        }
      ).__chart.series.get().bars.map((bar) => bar.l),
    );
    expect(Math.min(...lows)).toBeGreaterThan(0);
  });

  test('searches without a key, and skips what it cannot chart', async ({ page }) => {
    await stubYahoo(page);
    await open(page);
    await page.click('#symbol-button');
    await page.waitForSelector('#search-input', { state: 'visible' });
    await page.fill('#search-input', 'palantir');
    await page.waitForTimeout(800);
    const symbols = await page.$$eval('#search-results li', (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset['symbol'] ?? ''),
    );
    expect(symbols).toContain('PLTR');
    expect(symbols).not.toContain('ES=F');
  });

  test('stays out of the chain when nothing is proxying', async ({ page }) => {
    // A plain build — no `?yahoo=1` — must not offer six timeframes it cannot fetch. This
    // is the artifact's situation, and the reason readiness is passed in rather than
    // assumed.
    await page.route('**/yahoo/**', (route) => route.abort());
    await page.goto('/');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.click('#legend .src-open');
    await page.waitForSelector('#data-status[open]');
    expect(await page.textContent('#data-status-body')).not.toContain('Yahoo');
  });
});
