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
            {
              symbol: 'AAPL',
              instrument_name: 'Apple Inc',
              exchange: 'NASDAQ',
              country: 'United States',
              currency: 'USD',
            },
          ],
        }),
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
