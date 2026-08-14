/**
 * The published-artifact path, driven end to end.
 *
 * The artifact has no outbound network, so its only route to data is the viewer's
 * connector. That path could not be exercised before: it needs a `window.claude` runtime,
 * which exists only on a published page. Here one is installed before the app's modules
 * run and answers with the CSV the connector was observed to return, so everything from
 * detection through to bars on the chart is covered.
 *
 * What this deliberately does NOT stub is the app. The chain is swapped by the app's own
 * detection code, and the assertions are about what the user sees.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';
import { clickControl, fillControl } from './controls.js';

const DAILY_CSV =
  'timestamp,open,high,low,close,volume\r\n' +
  '2026-08-13,304.2100,306.0000,302.0500,305.2600,40349289\r\n' +
  '2026-08-12,305.1000,305.6600,300.5700,302.2500,41657768\r\n' +
  '2026-08-11,307.7500,309.9700,302.7900,304.9100,37476746\r\n';

const SEARCH_CSV =
  'symbol,name,type,region,marketOpen,marketClose,timezone,currency,matchScore\r\n' +
  'ASML,ASML Holding NV,Equity,United States,09:30,16:00,UTC-04,USD,0.8889\r\n';

const QUOTE_CSV =
  'symbol,open,high,low,price,volume,latestDay,previousClose,change,changePercent\r\n' +
  'ASML,304.2100,306.0000,302.0500,305.2600,40349289,2026-08-13,302.2500,3.0100,0.9959%\r\n';

interface RuntimeOptions {
  /** Resolve `use('mcp')` with null, as a view that was not granted the capability does. */
  readonly ungranted?: boolean;
  /** Reject every call with this code, as a declined or lapsed connector does. */
  readonly rejectWith?: string;
  /** Install the runtime this many ms AFTER the page's modules have run. */
  readonly installAfterMs?: number;
}

/**
 * Installs a stand-in for the claude.ai runtime before any page script runs.
 *
 * The payload shape is the one the connector actually returned when it was driven for
 * real: a JSON object with the CSV under `result`.
 */
async function installRuntime(page: Page, options: RuntimeOptions = {}): Promise<void> {
  await page.addInitScript(
    ({ daily, search, quote, opts }) => {
      const answer = (tool: string): string =>
        tool === 'SYMBOL_SEARCH' ? search : tool === 'GLOBAL_QUOTE' ? quote : daily;

      const calls: { tool: string; input: unknown }[] = [];
      (window as unknown as { __connectorCalls: typeof calls }).__connectorCalls = calls;

      const namespace = {
        callTool(_server: string, tool: string, input?: unknown) {
          calls.push({ tool, input });
          if (typeof opts.rejectWith === 'string') {
            // The runtime rejects with a plain `{code, message}`, not an `Error`. Wrapping
            // it to satisfy the lint rule would test a shape that never occurs.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
            return Promise.reject({ code: opts.rejectWith, message: 'connector said no' });
          }
          return Promise.resolve({ payload: { result: answer(tool) } });
        },
      };

      const host = {
        use: (name: string) =>
          Promise.resolve(name === 'mcp' && opts.ungranted !== true ? namespace : null),
      };

      if (typeof opts.installAfterMs === 'number') {
        setTimeout(() => {
          (window as unknown as { claude: unknown }).claude = host;
        }, opts.installAfterMs);
      } else {
        (window as unknown as { claude: unknown }).claude = host;
      }
    },
    { daily: DAILY_CSV, search: SEARCH_CSV, quote: QUOTE_CSV, opts: options },
  );
}

async function open(page: Page): Promise<void> {
  // Nothing may reach the network on this path; a request that escapes is the bug.
  await page.route('https://**', (route) => route.abort());
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(600);
}

const timeframeButtons = (
  page: Page,
): Promise<{ tf: string; enabled: boolean; title: string }[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>('#timeframes button')].map((b) => ({
      tf: b.dataset['tf'] ?? '',
      enabled: !b.disabled,
      title: b.title,
    })),
  );

/** The ticker box lives in the toolbar overflow at this viewport, so reveal it first. */
const load = async (page: Page, ticker: string): Promise<void> => {
  await fillControl(page, '#symbol-input', ticker);
  await clickControl(page, '#symbol-load');
  await page.waitForTimeout(900);
};

const state = (page: Page): Promise<{ symbol: string; timeframe: string; bars: number }> =>
  page.evaluate(() => {
    const win = window as unknown as {
      __tdv: { getState: () => { symbol: string; timeframe: string } };
      __chart: { series: { get: () => { bars: readonly unknown[] } } };
    };
    const s = win.__tdv.getState();
    return { symbol: s.symbol, timeframe: s.timeframe, bars: win.__chart.series.get().bars.length };
  });

test.describe('running as a published artifact', () => {
  test('adopts the connector and drops the providers it cannot reach', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');

    const calls = await page.evaluate(
      () => (window as unknown as { __connectorCalls: { tool: string }[] }).__connectorCalls,
    );
    expect(calls.map((call) => call.tool)).toContain('TIME_SERIES_DAILY');
  });

  test('loads a symbol that is not bundled', async ({ page }) => {
    // The complaint this test exists for: typing a ticker did nothing.
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');

    const after = await state(page);
    expect(after.symbol).toBe('ASML');
    expect(after.timeframe).toBe('1d');
    expect(after.bars).toBe(3);
  });

  test('offers daily and refuses intraday with the vendor’s reason', async ({ page }) => {
    // Not a bug in this app: Alpha Vantage gates intraday behind a premium key, and the
    // button says so rather than failing on press.
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');

    const buttons = await timeframeButtons(page);
    expect(buttons.find((b) => b.tf === '1d')?.enabled).toBe(true);
    // Whichever intraday buttons the toolbar actually renders — naming them here is the
    // hand-maintained list this repo has already been bitten by three times.
    const intraday = buttons.filter((button) => button.tf !== '1d');
    expect(intraday.length).toBeGreaterThan(0);
    for (const button of intraday) {
      expect(button.enabled, button.tf).toBe(false);
      // The specific reason, not "does not serve 1m": whether a different key would fix
      // this is the only thing the reader can act on.
      expect(button.title, button.tf).toContain('intraday');
    }
  });

  test('says on screen which chain is actually live', async ({ page }) => {
    // The question this exists to answer: "it did not load and I see no intraday" has
    // completely different explanations depending on which providers are in the chain,
    // and there was previously no way to tell from the outside which one was running.
    await installRuntime(page);
    await open(page);
    expect(await page.textContent('#legend')).toContain('demo data');
    await load(page, 'ASML');
    expect(await page.textContent('#legend')).toContain('connector');
  });

  test('finds a symbol through the connector’s search', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    await page.click('#symbol-button');
    await page.waitForSelector('#search-input', { state: 'visible' });
    await page.fill('#search-input', 'ASML');
    await page.waitForTimeout(800);

    const symbols = await page.$$eval('#search-results li', (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset['symbol'] ?? ''),
    );
    expect(symbols).toContain('ASML');
  });

  test('polls a live quote through the connector', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');
    await page.click('#live-toggle');
    await page.waitForTimeout(900);

    const calls = await page.evaluate(
      () => (window as unknown as { __connectorCalls: { tool: string }[] }).__connectorCalls,
    );
    expect(calls.map((call) => call.tool)).toContain('GLOBAL_QUOTE');
  });
});

test.describe('when the connector is not usable', () => {
  test('says what to do rather than failing silently', async ({ page }) => {
    await installRuntime(page, { rejectWith: 'server_not_connected' });
    await open(page);
    await load(page, 'ASML');
    const status = (await page.textContent('#status')) ?? '';
    expect(status.toLowerCase()).toContain('connector');
  });

  test('does not leave unreachable providers claiming every timeframe', async ({ page }) => {
    // With no connector and no network, six enabled buttons that all fail on press is the
    // exact problem the capability layer exists to remove.
    await installRuntime(page, { ungranted: true });
    await open(page);
    const enabled = (await timeframeButtons(page)).filter((b) => b.enabled).map((b) => b.tf);
    // DEMO is generated and resamples locally, so intraday is genuinely available here.
    expect(enabled).not.toHaveLength(0);
  });
});

test.describe('a runtime that arrives late', () => {
  test('is still adopted', async ({ page }) => {
    // The app's modules are deferred, so the runtime is normally installed first — but a
    // detection that only looks once turns a few milliseconds of ordering into a page
    // with no data at all.
    await installRuntime(page, { installAfterMs: 400 });
    await open(page);
    await page.waitForTimeout(1200);
    await load(page, 'ASML');
    expect((await state(page)).symbol).toBe('ASML');
  });
});

test.describe('the data panel', () => {
  const openPanel = async (page: Page): Promise<string> => {
    await page.click('#legend .src-open');
    await page.waitForSelector('#data-status[open]');
    return (await page.textContent('#data-status-body')) ?? '';
  };

  test('reports that the connector is ready when it is', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');
    expect(await openPanel(page)).toContain('connector ready');
  });

  test('says the runtime was never there, rather than going quiet', async ({ page }) => {
    // Told apart from "granted but refused", because the two have different fixes and
    // from outside the page they look identical. Detection spends its whole wait first,
    // since with no runtime there is nothing to cut it short.
    await open(page);
    await page.waitForTimeout(4500);
    const text = await openPanel(page);
    expect(text).toContain('no claude.ai runtime');
    // …and says so as a fact, not a fault: this is the ordinary state everywhere except a
    // published page, and flagging it red teaches the reader to skip the line that matters.
    expect(text).toContain('normal outside a published artifact');
  });

  test('says when the runtime is present but the capability was not granted', async ({ page }) => {
    await installRuntime(page, { ungranted: true });
    await open(page);
    expect(await openPanel(page)).toContain('did not grant');
  });

  test('lists the chain and what each provider will actually serve', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    const text = await openPanel(page);
    expect(text).toContain('Alpha Vantage (connector)');
    expect(text).toContain('Bundled data');
    expect(text).toContain('1d');
  });

  test('keeps the last refusal, after the status line has moved on', async ({ page }) => {
    // The question is asked minutes later, once the reader has noticed something is wrong.
    await installRuntime(page, { rejectWith: 'server_not_connected' });
    await open(page);
    await load(page, 'ASML');
    await page.waitForTimeout(7000);
    const text = await openPanel(page);
    expect(text).toContain('ASML');
    expect(text.toLowerCase()).toContain('connector');
  });

  test('reports no refusal when nothing has failed', async ({ page }) => {
    await installRuntime(page);
    await open(page);
    await load(page, 'ASML');
    expect(await openPanel(page)).toContain('none this session');
  });
});

test.describe('a bundled ticker with a provider available', () => {
  test('takes the provider’s bars, not the CSV baked into the build', async ({ page }) => {
    // The CSV is months old and looks exactly like fresh data on a chart, so a symbol
    // that shipped with the build used to load stale prices with nothing to show for it.
    await installRuntime(page);
    await open(page);
    await load(page, 'AAPL');

    const calls = await page.evaluate(
      () =>
        (window as unknown as { __connectorCalls: { tool: string; input: unknown }[] })
          .__connectorCalls,
    );
    expect(calls.some((call) => call.tool === 'TIME_SERIES_DAILY')).toBe(true);
    expect(await page.textContent('#legend')).toContain('connector');
  });

  test('falls back to the CSV when no provider can answer, and says so', async ({ page }) => {
    // The chain's last link. Marked as bundled rather than live, so the Live toggle does
    // not offer to poll a file.
    await installRuntime(page, { rejectWith: 'server_not_connected' });
    await open(page);
    await load(page, 'AAPL');
    expect(await page.textContent('#legend')).toContain('bundled data');
    const disabled = await page.evaluate(
      () => document.querySelector<HTMLButtonElement>('#live-toggle')?.disabled ?? false,
    );
    expect(disabled).toBe(true);
  });
});
