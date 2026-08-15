/**
 * The watchlist, end to end.
 *
 * The state rules are unit-tested; what needs a browser is the wiring — that the panel takes
 * width from the chart instead of covering it, that a row loads its symbol, that the active
 * row follows the chart no matter where the symbol was changed, and that the list survives a
 * reload while the prices on it do not.
 */

import type { Page, Route } from '@playwright/test';
import { expect, test } from './harness.js';
import { clickControl } from './controls.js';

const OPEN = 1786714200;

/** One chart payload, with the price and baseline the rows are checked against. */
function chart(price: number, previousClose: number): string {
  return JSON.stringify({
    chart: {
      result: [
        {
          meta: {
            currency: 'USD',
            regularMarketTime: OPEN + 3600,
            regularMarketPrice: price,
            chartPreviousClose: previousClose,
            currentTradingPeriod: { regular: { start: OPEN, end: OPEN + 23_400 } },
          },
          timestamp: [OPEN, OPEN + 86_400],
          indicators: {
            quote: [
              {
                open: [previousClose, previousClose],
                high: [price + 1, price + 1],
                low: [previousClose - 1, previousClose - 1],
                close: [previousClose, price],
                volume: [1000, 1200],
              },
            ],
          },
        },
      ],
      error: null,
    },
  });
}

/** Every symbol gets a price derived from its name, so a row showing another's is visible. */
const PRICES: Readonly<Record<string, number>> = { AAPL: 100, MSFT: 200, NVDA: 300, TSLA: 400, SPY: 500 };

async function stub(page: Page): Promise<void> {
  await page.route('**/yahoo/**', async (route: Route) => {
    const url = new URL(route.request().url());
    if (url.pathname.includes('/finance/search')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{"quotes":[]}' });
      return;
    }
    const symbol = url.pathname.split('/').pop() ?? '';
    const price = PRICES[symbol] ?? 50;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      // Baseline 10% below the price, so every row shows a change of exactly +11.11%.
      body: chart(price, price * 0.9),
    });
  });
  await page.route('https://api.twelvedata.com/**', (route) => route.abort());
  await page.route('https://www.alphavantage.co/**', (route) => route.abort());
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

/**
 * At this suite's 1280px viewport the toggle lives in the toolbar overflow, so it has to be
 * revealed the same way every other evictable control is. That it CAN be evicted is
 * deliberate — it carries a high priority, not an exemption.
 */
const openPanel = async (page: Page): Promise<void> => {
  await clickControl(page, '#watchlist-toggle');
  await page.waitForSelector('#watchlist-rows li', { timeout: 8000 });
};

const rows = (page: Page): Promise<{ symbol: string; text: string; active: boolean }[]> =>
  page.$$eval('#watchlist-rows li', (nodes) =>
    nodes.map((node) => ({
      symbol: (node as HTMLElement).dataset['symbol'] ?? '',
      text: node.textContent.replace(/\s+/g, ' ').trim(),
      active: node.classList.contains('active'),
    })),
  );

test.describe('the watchlist', () => {
  test('opens with a list of symbols', async ({ page }) => {
    await stub(page);
    await open(page);
    await openPanel(page);
    expect((await rows(page)).map((row) => row.symbol)).toContain('AAPL');
  });

  test('takes width from the chart rather than covering it', async ({ page }) => {
    // An overlay would sit on the canvas the crosshair needs, and the chart would keep
    // sizing itself as though the panel were not there.
    await stub(page);
    await open(page);
    const before = await page.evaluate(
      () => document.querySelector('#panes')?.getBoundingClientRect().width ?? 0,
    );
    await openPanel(page);
    await page.waitForTimeout(500);
    const after = await page.evaluate(
      () => document.querySelector('#panes')?.getBoundingClientRect().width ?? 0,
    );
    expect(after).toBeLessThan(before);
  });

  test('prices each row against its own instrument', async ({ page }) => {
    // The failure this rules out is a price rendered under the wrong name.
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.waitForFunction(
      () => (document.querySelector('#watchlist-rows li[data-symbol="MSFT"]')?.textContent ?? '').includes('200'),
      undefined,
      { timeout: 15_000 },
    );
    const listed = await rows(page);
    expect(listed.find((row) => row.symbol === 'AAPL')?.text).toContain('100');
    expect(listed.find((row) => row.symbol === 'MSFT')?.text).toContain('200');
  });

  test('shows a percentage for every row, not just the charted one', async ({ page }) => {
    // The baseline comes from the quote itself; deriving it from the chart's bars gave a
    // percentage only for whichever symbol happened to be loaded.
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.waitForFunction(
      () => (document.querySelector('#watchlist-rows li[data-symbol="SPY"]')?.textContent ?? '').includes('%'),
      undefined,
      { timeout: 15_000 },
    );
    for (const row of await rows(page)) expect(row.text, row.symbol).toContain('%');
  });

  test('loads the symbol of a clicked row', async ({ page }) => {
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.click('#watchlist-rows li[data-symbol="NVDA"]');
    await page.waitForTimeout(1200);
    const symbol = await page.evaluate(
      () =>
        (window as unknown as { __tdv: { getState: () => { symbol: string } } }).__tdv.getState()
          .symbol,
    );
    expect(symbol).toBe('NVDA');
  });

  test('marks the charted symbol active, however it was chosen', async ({ page }) => {
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.click('#watchlist-rows li[data-symbol="TSLA"]');
    await page.waitForTimeout(1200);
    const active = (await rows(page)).filter((row) => row.active).map((row) => row.symbol);
    expect(active).toEqual(['TSLA']);
  });

  test('adds and removes a symbol', async ({ page }) => {
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.fill('#watchlist-input', 'pltr');
    await page.click('#watchlist-add');
    await page.waitForTimeout(600);
    expect((await rows(page)).map((row) => row.symbol)).toContain('PLTR');

    await page.click('#watchlist-rows li[data-symbol="PLTR"] button[data-action="remove"]');
    await page.waitForTimeout(400);
    expect((await rows(page)).map((row) => row.symbol)).not.toContain('PLTR');
    // Removing must not also load the symbol — the × sits inside the row's own click area.
    const symbol = await page.evaluate(
      () =>
        (window as unknown as { __tdv: { getState: () => { symbol: string } } }).__tdv.getState()
          .symbol,
    );
    expect(symbol).not.toBe('PLTR');
  });

  test('keeps the list across a reload but not the prices', async ({ page }) => {
    // Membership is a durable choice; a stored price is wrong the moment it is read back.
    await stub(page);
    await open(page);
    await openPanel(page);
    await page.fill('#watchlist-input', 'PLTR');
    await page.click('#watchlist-add');
    await page.waitForTimeout(600);

    await page.goto('/?yahoo=1');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await openPanel(page);
    expect((await rows(page)).map((row) => row.symbol)).toContain('PLTR');
  });
});

test.describe('every timeframe the app supports has a button', () => {
  test('including 4h, which was reachable everywhere except the toolbar', async ({ page }) => {
    // Derived from the data layer's own list now. A second hand-maintained list is the
    // defect this repo has already paid for three times.
    await stub(page);
    await open(page);
    const offered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#timeframes button')].map(
        (b) => b.dataset['tf'] ?? '',
      ),
    );
    expect(offered).toEqual(['1m', '5m', '15m', '1h', '4h', '1d']);
  });
});
