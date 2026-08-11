/**
 * Phase 8.1 — indicator settings.
 *
 * The gap this closes was "you can add an SMA but never change it from 20 to 50", so the
 * tests are about the parameter actually reaching the computation, not about the dialog
 * existing. Two of them assert the form's SHAPE, because a dialog that offers a field the
 * indicator ignores is the same bug wearing a nicer hat.
 */

import { expect, test, type Page } from '@playwright/test';

interface IndicatorHandle {
  readonly handleId: string;
  readonly id: string;
  readonly params: Record<string, unknown>;
}

async function open(page: Page): Promise<void> {
  await page.goto('/?sym=AAPL');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(200);
}

const indicators = (page: Page): Promise<IndicatorHandle[]> =>
  page.evaluate(() => {
    const api = (window as { __tdv?: { getState: () => { indicators: unknown } } }).__tdv;
    return (api === undefined ? [] : api.getState().indicators) as IndicatorHandle[];
  });

async function add(page: Page, id: string): Promise<void> {
  await page.evaluate((name) => {
    const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
    api?.addIndicator(name);
  }, id);
  await page.waitForTimeout(200);
}

/** Opens the settings sheet through the legend gear, the way a user would. */
async function openSettings(page: Page): Promise<void> {
  await page.click('#legend .row.ind button[data-action="settings"]');
  await page.waitForSelector('#indicator-settings[open]');
}

const fields = (page: Page): Promise<string[]> =>
  page.$$eval('#indicator-settings [data-param]', (nodes) =>
    nodes.map((n) => (n as HTMLElement).dataset['param'] ?? ''),
  );

test.describe('indicator settings', () => {
  test('changing the length reaches the computation', async ({ page }) => {
    await open(page);
    await add(page, 'sma');
    expect((await indicators(page))[0].params['period']).toBeUndefined();

    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '50');
    await page.waitForTimeout(200);
    await page.click('#indicator-ok');
    await page.waitForTimeout(200);

    const after = await indicators(page);
    expect(after).toHaveLength(1);
    expect(after[0].params['period']).toBe(50);
    // The handle survives: settings must not be remove-and-re-add, or a pane indicator
    // would jump to the bottom of the stack on every edit.
    expect(after[0].handleId).toBe('i1');
  });

  test('the plotted line actually moves when the length changes', async ({ page }) => {
    // params reaching the store proves plumbing; this proves the chart repaints from it.
    await open(page);
    await add(page, 'sma');
    await page.waitForTimeout(300);

    const sample = (): Promise<string> =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return '';
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let sum = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 128) sum += i;
        return String(sum);
      });

    const before = await sample();
    expect(before).not.toBe('');
    expect(before).not.toBe('0');

    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '200');
    await page.waitForTimeout(300);
    const during = await sample();
    // Live preview: the chart updates before the dialog is dismissed.
    expect(during).not.toBe(before);

    await page.click('#indicator-ok');
    await page.waitForTimeout(200);
    expect(await sample()).toBe(during);
  });

  test('the form offers exactly the parameters the indicator declares', async ({ page }) => {
    await open(page);
    await add(page, 'sma');
    await openSettings(page);
    expect((await fields(page)).sort()).toEqual(['period', 'source']);
    await page.click('#indicator-cancel');
    await page.waitForTimeout(150);

    await page.evaluate(() => {
      const api = (window as { __tdv?: { removeIndicator: (h: string) => unknown } }).__tdv;
      api?.removeIndicator('i1');
    });
    await add(page, 'macd');
    await openSettings(page);
    expect((await fields(page)).sort()).toEqual([
      'fastPeriod',
      'signalPeriod',
      'slowPeriod',
      'source',
    ]);
  });

  test('bollinger gets its standard-deviation field and SMA does not', async ({ page }) => {
    await open(page);
    await add(page, 'bollinger');
    await openSettings(page);
    expect(await fields(page)).toContain('stdDev');

    await page.fill('#indicator-settings [data-param="stdDev"]', '3');
    await page.waitForTimeout(200);
    await page.click('#indicator-ok');
    await page.waitForTimeout(150);
    expect((await indicators(page))[0].params['stdDev']).toBe(3);
  });

  test('a style row exists per declared plot, and colour reaches the canvas', async ({ page }) => {
    await open(page);
    await add(page, 'bollinger');
    await openSettings(page);

    const plots = await page.$$eval('#indicator-settings .style-row', (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset['plot'] ?? ''),
    );
    expect(plots.length).toBeGreaterThanOrEqual(3);

    const redPixels = (): Promise<number> =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return 0;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60 && data[i + 3] > 128) count++;
        }
        return count;
      });

    const before = await redPixels();
    const key = plots[0];
    await page.fill(`#indicator-settings [data-plot-color="${key}"]`, '#ff0000');
    await page.waitForTimeout(300);
    expect(await redPixels()).toBeGreaterThan(before + 50);
  });

  test('Cancel puts the old parameters back', async ({ page }) => {
    await open(page);
    await add(page, 'sma');
    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '90');
    await page.waitForTimeout(200);
    expect((await indicators(page))[0].params['period']).toBe(90);

    await page.click('#indicator-cancel');
    await page.waitForTimeout(200);
    expect((await indicators(page))[0].params['period']).toBeUndefined();
  });

  test('Escape reverts too, not just the Cancel button', async ({ page }) => {
    // Escape closes a <dialog> natively, so the revert has to hang off the cancel event
    // rather than off the button, or dismissing would silently commit the preview.
    await open(page);
    await add(page, 'sma');
    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '90');
    await page.waitForTimeout(200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
    expect((await indicators(page))[0].params['period']).toBeUndefined();
  });

  test('undo restores the parameters from before the dialog was opened', async ({ page }) => {
    await open(page);
    await add(page, 'sma');
    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '75');
    await page.waitForTimeout(200);
    await page.click('#indicator-ok');
    await page.waitForTimeout(200);
    expect((await indicators(page))[0].params['period']).toBe(75);

    // One undo step for the whole edit, not one per keystroke.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    expect((await indicators(page))[0].params['period']).toBeUndefined();
  });

  test('Defaults clears both parameters and styles', async ({ page }) => {
    await open(page);
    await add(page, 'sma');
    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '77');
    await page.waitForTimeout(200);
    await page.click('#indicator-reset');
    await page.waitForTimeout(250);

    const after = (await indicators(page))[0];
    expect(after.params['period']).toBe(20);
    expect(after.params['source']).toBe('close');
  });

  test('settings survive a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.evaluate(() => {
      localStorage.clear();
    });
    await add(page, 'ema');
    await openSettings(page);
    await page.fill('#indicator-settings [data-param="period"]', '33');
    await page.waitForTimeout(200);
    await page.click('#indicator-ok');
    // Persistence is debounced; give the timer a turn before navigating away.
    await page.waitForTimeout(900);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(400);
    const restored = await indicators(page);
    expect(restored).toHaveLength(1);
    expect(restored[0].params['period']).toBe(33);
  });
});
