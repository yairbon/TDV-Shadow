/**
 * Long sessions, driven end to end.
 *
 * The per-feature specs each hold one thing still and check it. This file does the
 * opposite: it strings features together the way a person would and checks only that the
 * chart is still healthy afterwards. Every bug found by hand rather than by the suite has
 * come from an interaction BETWEEN features — a replay cursor meeting a resampling chart
 * type, a pane switch meeting a half-placed drawing — and none of them were reachable
 * from a test that exercised one feature at a time.
 *
 * The error harness does the heavy lifting here: an uncaught exception anywhere in these
 * sequences fails the test, which is how a boot-time ReferenceError would have been
 * caught the first time.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

interface Integrity {
  readonly painted: number;
  readonly candlesOverlap: boolean;
  readonly outsidePlot: number;
  readonly nonCanvasNodesInPlot: number;
  readonly backingStoreMatchesDpr: boolean;
  readonly ok: boolean;
}

async function open(page: Page, query = ''): Promise<void> {
  await page.addInitScript(() => {
    try {
      if (sessionStorage.getItem('tdv-test-cleared') === null) {
        localStorage.clear();
        sessionStorage.setItem('tdv-test-cleared', '1');
      }
    } catch {
      /* private mode; nothing to clear */
    }
  });
  await page.goto(`/${query}`);
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

const integrity = (page: Page): Promise<Integrity> =>
  page.evaluate(() => {
    const api = (window as { __tdv?: { getIntegrityReport: () => Integrity } }).__tdv;
    return (
      api?.getIntegrityReport() ?? {
        painted: 0,
        candlesOverlap: false,
        outsidePlot: -1,
        nonCanvasNodesInPlot: -1,
        backingStoreMatchesDpr: false,
        ok: false,
      }
    );
  });

/** Asserts the chart is still a chart: painting, in bounds, canvas-only, DPR-correct. */
async function expectHealthy(page: Page, label: string): Promise<void> {
  const report = await integrity(page);
  expect(report.painted, `${label}: nothing painted`).toBeGreaterThan(1000);
  expect(report.candlesOverlap, `${label}: candles overlap`).toBe(false);
  expect(report.outsidePlot, `${label}: candles outside the plot`).toBe(0);
  expect(report.nonCanvasNodesInPlot, `${label}: DOM inside the plot`).toBe(0);
  expect(report.backingStoreMatchesDpr, `${label}: DPR mismatch`).toBe(true);
}

const addDrawing = async (page: Page, y: number): Promise<void> => {
  await page.keyboard.press('Alt+h');
  await page.waitForTimeout(120);
  const box = await page.locator('#chart').boundingBox();
  await page.mouse.click((box?.x ?? 0) + 220, (box?.y ?? 0) + y);
  await page.waitForTimeout(180);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
};

test.describe('long sessions', () => {
  test('analysis session: indicators, drawings, alerts, measure, undo', async ({ page }) => {
    await open(page);

    await page.evaluate(() => {
      const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
      api?.addIndicator('sma');
      api?.addIndicator('bollinger');
      api?.addIndicator('macd');
    });
    await page.waitForTimeout(500);
    await expectHealthy(page, 'after indicators');

    await addDrawing(page, 200);
    await addDrawing(page, 280);

    // Measure across the plot.
    const box = await page.locator('#chart').boundingBox();
    await page.keyboard.down('Shift');
    await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
    await page.mouse.down();
    await page.mouse.move((box?.x ?? 0) + 500, (box?.y ?? 0) + 320, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await page.waitForTimeout(200);

    // An alert from the price gutter.
    const gutter = await page.evaluate(() => {
      const chart = (window as {
        __chart?: { layout: () => { priceGutter: { left: number; width: number } } };
      }).__chart;
      const g = chart?.layout().priceGutter ?? { left: 0, width: 0 };
      return g.left + g.width / 2;
    });
    await page.mouse.click((box?.x ?? 0) + gutter, (box?.y ?? 0) + 240, { button: 'right' });
    await page.waitForSelector('#context-menu [data-label="Add alert here"]');
    await page.click('#context-menu [data-label="Add alert here"]');
    await page.waitForTimeout(250);

    await expectHealthy(page, 'after annotations');
    const before = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          drawings: { list: () => readonly unknown[] };
          alerts: { list: () => readonly unknown[] };
        };
      }).__chart;
      return {
        drawings: chart?.drawings.list().length ?? -1,
        alerts: chart?.alerts.list().length ?? -1,
      };
    });
    expect(before).toEqual({ drawings: 2, alerts: 1 });

    // Undo the drawings back out, one step each.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);
    const after = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { list: () => readonly unknown[] } } })
        .__chart;
      return chart?.drawings.list().length ?? -1;
    });
    expect(after).toBe(0);
    await expectHealthy(page, 'after undo');
  });

  test('every chart type in turn, with indicators and a drawing attached', async ({ page }) => {
    // The combination that broke before: a resampling type changes the index space under
    // annotations and indicators that were computed in the previous one.
    await open(page, '?seed=7&bars=600&live=0');
    await page.evaluate(() => {
      const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
      api?.addIndicator('sma');
      api?.addIndicator('volume');
    });
    await addDrawing(page, 220);
    await page.waitForTimeout(300);

    const types = await page.$$eval('#chart-type option', (nodes) =>
      nodes.map((n) => (n as HTMLOptionElement).value),
    );
    expect(types.length).toBe(14);

    for (const type of types) {
      await page.selectOption('#chart-type', type);
      await page.waitForTimeout(350);
      await expectHealthy(page, type);
      const drawings = await page.evaluate(() => {
        const chart = (window as { __chart?: { drawings: { list: () => readonly unknown[] } } })
          .__chart;
        return chart?.drawings.list().length ?? -1;
      });
      // The drawing survives every switch — it is remapped, never dropped.
      expect(drawings, type).toBe(1);
    }
  });

  test('scale modes and inversion compose with a resampling type', async ({ page }) => {
    await open(page, '?seed=7&bars=600&live=0');
    await page.selectOption('#chart-type', 'renko');
    await page.waitForTimeout(300);

    await page.click('#scale-log');
    await page.waitForTimeout(300);
    await expectHealthy(page, 'renko + log');

    const box = await page.locator('#chart').boundingBox();
    const gutter = await page.evaluate(() => {
      const chart = (window as {
        __chart?: { layout: () => { priceGutter: { left: number; width: number } } };
      }).__chart;
      const g = chart?.layout().priceGutter ?? { left: 0, width: 0 };
      return g.left + g.width / 2;
    });
    await page.mouse.click((box?.x ?? 0) + gutter, (box?.y ?? 0) + 200, { button: 'right' });
    await page.waitForSelector('#context-menu [data-label="Invert price scale"]');
    await page.click('#context-menu [data-label="Invert price scale"]');
    await page.waitForTimeout(350);
    await expectHealthy(page, 'renko + log + inverted');
  });

  test('replay composes with a resampling type and with indicators', async ({ page }) => {
    await open(page, '?seed=7&bars=600&live=0');
    await page.evaluate(() => {
      const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
      api?.addIndicator('rsi');
    });
    await page.waitForTimeout(300);

    await page.keyboard.press('r');
    await page.waitForTimeout(400);
    await expectHealthy(page, 'replay on candles');

    await page.selectOption('#chart-type', 'renko');
    await page.waitForTimeout(400);
    await expectHealthy(page, 'replay on renko');

    await page.click('#replay-forward');
    await page.click('#replay-forward');
    await page.waitForTimeout(300);
    await expectHealthy(page, 'replay stepped');

    await page.click('#replay-exit');
    await page.waitForTimeout(400);
    await expectHealthy(page, 'replay exited');
  });

  test('a four-pane session survives switching everything', async ({ page }) => {
    await open(page);
    await page.selectOption('#layout-pick', '4');
    await page.waitForTimeout(800);

    const clickPane = async (index: number): Promise<void> => {
      const box = await page.locator(`#panes .pane[data-pane="${String(index)}"]`).boundingBox();
      await page.mouse.click((box?.x ?? 0) + 80, (box?.y ?? 0) + 120);
      await page.waitForTimeout(220);
    };

    for (const [index, symbol] of [
      [1, 'AAPL'],
      [2, 'MSFT'],
      [3, 'SPY'],
    ] as const) {
      await clickPane(index);
      await page.selectOption('#symbol-pick', symbol);
      await page.waitForTimeout(450);
      await expectHealthy(page, `pane ${String(index)} = ${symbol}`);
    }

    await clickPane(0);
    await page.selectOption('#chart-type', 'heikin-ashi');
    await page.waitForTimeout(300);
    await page.click('#theme-toggle');
    await page.waitForTimeout(700);
    await expectHealthy(page, 'after theme toggle');

    await page.selectOption('#layout-pick', '1');
    await page.waitForTimeout(600);
    await expectHealthy(page, 'back to one pane');
    expect(await page.locator('#panes .pane').count()).toBe(1);
  });

  test('the timeframe buttons compose with indicators and drawings', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
      api?.addIndicator('ema');
    });
    await addDrawing(page, 240);
    await page.waitForTimeout(300);

    for (const tf of ['5m', '15m', '1h', '1m']) {
      await page.click(`#timeframes button[data-tf="${tf}"]`);
      await page.waitForTimeout(400);
      await expectHealthy(page, `timeframe ${tf}`);
    }
  });
});
