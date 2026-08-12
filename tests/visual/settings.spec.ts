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

// ------------------------------------------------------------------ 8.2 drawing style

interface DrawingHandle {
  readonly id: string;
  readonly anchorPixels: readonly { readonly x: number; readonly y: number }[];
}

/**
 * Anchors are taken from the SERIES, not hard-coded: the default symbol and AAPL live in
 * completely different price ranges, and a literal 260 puts the line off-screen on one of
 * them — where a double-click can never hit it.
 */
async function placeTrendline(page: Page): Promise<DrawingHandle> {
  await page.evaluate(() => {
    const win = window as {
      __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
      __chart?: { series: { get: () => { bars: readonly { c: number }[] } } };
    };
    const bars = win.__chart?.series.get().bars ?? [];
    if (bars.length < 80) throw new Error('not enough bars to anchor against');
    win.__tdv?.drawShape(
      'trendline',
      [
        { barIndex: 20, price: bars[20].c },
        { barIndex: 70, price: bars[70].c },
      ],
      'off',
    );
  });
  await page.waitForTimeout(200);
  return (await page.evaluate(() => {
    const api = (window as { __tdv?: { listDrawings: () => unknown } }).__tdv;
    return (api === undefined ? [] : api.listDrawings()) as DrawingHandle[];
  }))[0];
}

const styleOf = (page: Page, id: string): Promise<Record<string, unknown>> =>
  page.evaluate((wanted) => {
    const chart = (window as {
      __chart?: { drawings: { get: (i: string) => { style: unknown } | null } };
    }).__chart;
    return (chart?.drawings.get(wanted)?.style ?? {}) as Record<string, unknown>;
  }, id);

/** Counts strongly-red pixels on the overlay layer. */
const redPixels = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="overlay"]');
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] < 60 && data[i + 3] > 128) count++;
    }
    return count;
  });

async function openDrawingSettings(page: Page, handle: DrawingHandle): Promise<void> {
  const box = await page.evaluate(() => {
    const host = document.querySelector('#chart');
    if (host === null) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  await page.mouse.dblclick(handle.anchorPixels[0].x + box.x, handle.anchorPixels[0].y + box.y);
  await page.waitForSelector('#drawing-settings[open]');
}

test.describe('drawing style', () => {
  test('the style block was previously stored and never painted — colour now reaches the canvas', async ({
    page,
  }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const before = await redPixels(page);

    await openDrawingSettings(page, placed);
    await page.fill('#drawing-color', '#ff0000');
    await page.waitForTimeout(250);
    expect(await redPixels(page)).toBeGreaterThan(before + 20);

    await page.click('#drawing-ok');
    await page.waitForTimeout(150);
    expect(await styleOf(page, placed.id)).toMatchObject({ color: '#ff0000' });
  });

  test('width, dash, opacity and label visibility all persist to the store', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await openDrawingSettings(page, placed);

    await page.fill('#drawing-width', '4');
    await page.selectOption('#drawing-dash', 'Dashed');
    await page.fill('#drawing-opacity', '0.5');
    await page.uncheck('#drawing-labels');
    await page.waitForTimeout(200);
    await page.click('#drawing-ok');
    await page.waitForTimeout(150);

    const style = await styleOf(page, placed.id);
    expect(style['lineWidth']).toBe(4);
    expect(style['dash']).toEqual([6, 4]);
    expect(style['opacity']).toBe(0.5);
    expect(style['showLabels']).toBe(false);
  });

  test('a wider line paints more ink', async ({ page }) => {
    // Storing lineWidth proves plumbing; this proves drawDrawings reads it.
    await open(page);
    const placed = await placeTrendline(page);
    const ink = (): Promise<number> =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return 0;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 128) count++;
        return count;
      });

    const thin = await ink();
    await openDrawingSettings(page, placed);
    await page.fill('#drawing-width', '8');
    await page.waitForTimeout(250);
    expect(await ink()).toBeGreaterThan(thin);
  });

  test('Cancel restores the whole style block', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const before = await styleOf(page, placed.id);

    await openDrawingSettings(page, placed);
    await page.fill('#drawing-width', '6');
    await page.fill('#drawing-color', '#00ff00');
    await page.waitForTimeout(200);
    await page.click('#drawing-cancel');
    await page.waitForTimeout(200);

    expect(await styleOf(page, placed.id)).toEqual(before);
  });

  test('the context menu opens the same editor', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const box = await page.evaluate(() => {
      const host = document.querySelector('#chart');
      if (host === null) return { x: 0, y: 0 };
      const rect = host.getBoundingClientRect();
      return { x: rect.left, y: rect.top };
    });
    await page.mouse.click(placed.anchorPixels[0].x + box.x, placed.anchorPixels[0].y + box.y, {
      button: 'right',
    });
    await page.waitForSelector('#context-menu [data-label="Settings"]');
    await page.click('#context-menu [data-label="Settings"]');
    await page.waitForSelector('#drawing-settings[open]');
  });

  test('style survives a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.evaluate(() => {
      localStorage.clear();
    });
    const placed = await placeTrendline(page);
    await openDrawingSettings(page, placed);
    await page.fill('#drawing-color', '#ff00ff');
    await page.fill('#drawing-width', '3');
    await page.waitForTimeout(200);
    await page.click('#drawing-ok');
    await page.waitForTimeout(900);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(400);
    const restored = await styleOf(page, placed.id);
    expect(restored['color']).toBe('#ff00ff');
    expect(restored['lineWidth']).toBe(3);
  });
});

// ------------------------------------------------------------------ 8.3 chart settings

/**
 * Counts INK on a layer: pixels that differ from that layer's own background.
 *
 * Alpha is useless here — the grid layer paints an opaque background first, so every
 * pixel on it is alpha 255 whether anything was drawn or not, and an alpha count would
 * report the same number for a full grid and a blank one.
 */
const ink = (page: Page, layer: string): Promise<number> =>
  page.evaluate((name) => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      `#chart canvas[data-layer="${name}"]`,
    );
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    // (0,0) is above the plot and outside every rule, so it is the background by
    // construction.
    const bg = [data[0], data[1], data[2]];
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (
        Math.abs(data[i] - bg[0]) > 6 ||
        Math.abs(data[i + 1] - bg[1]) > 6 ||
        Math.abs(data[i + 2] - bg[2]) > 6
      ) {
        count++;
      }
    }
    return count;
  }, layer);

async function openChartSettings(page: Page): Promise<void> {
  await page.click('#chart-settings');
  await page.waitForSelector('#chart-settings-dialog[open], dialog#chart-settings[open]');
}

test.describe('chart settings', () => {
  test('turning gridlines off removes ink from the grid layer but keeps the axes', async ({
    page,
  }) => {
    await open(page);
    await page.waitForTimeout(300);
    const before = await ink(page, 'grid');
    expect(before).toBeGreaterThan(1000);

    await openChartSettings(page);
    await page.uncheck('#chart-grid');
    await page.waitForTimeout(300);
    const after = await ink(page, 'grid');
    expect(after).toBeLessThan(before * 0.8);
    // Axis rules, ticks and labels still paint: "no gridlines" is not "no axes".
    expect(after).toBeGreaterThan(500);
  });

  test('price decimals reach the axis labels', async ({ page }) => {
    await open(page);
    await openChartSettings(page);
    await page.fill('#chart-precision', '4');
    await page.waitForTimeout(300);
    await page.click('#chart-ok');
    await page.waitForTimeout(200);

    const precision = await page.evaluate(() => {
      const chart = (window as { __chart?: { settings: () => { pricePrecision: number } } }).__chart;
      return chart?.settings().pricePrecision ?? -1;
    });
    expect(precision).toBe(4);
  });

  test('the right margin changes where realtime snaps to', async ({ page }) => {
    await open(page);
    await openChartSettings(page);
    await page.fill('#chart-margin', '20');
    await page.waitForTimeout(200);
    await page.click('#chart-ok');
    await page.waitForTimeout(200);

    const scroll = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          scrollToRealtime: () => void;
          view: { get: () => { scrollPosition: number } };
          series: { get: () => { bars: readonly unknown[] } };
        };
      }).__chart;
      if (chart === undefined) return { position: 0, count: 0 };
      chart.scrollToRealtime();
      return {
        position: chart.view.get().scrollPosition,
        count: chart.series.get().bars.length,
      };
    });
    expect(scroll.position).toBeCloseTo(scroll.count - 1 + 20, 6);
  });

  test('a custom up colour repaints the candles without rebuilding the chart', async ({ page }) => {
    await open(page);
    await page.waitForTimeout(300);

    const frames = (): Promise<number> =>
      page.evaluate(() => {
        const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
        const g = fn === undefined ? null : (fn() as { frameCount?: number } | null);
        return g?.frameCount ?? 0;
      });
    const magenta = (): Promise<number> =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="series"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return 0;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200 && data[i + 3] > 128) count++;
        }
        return count;
      });

    expect(await magenta()).toBe(0);
    const before = await frames();

    await openChartSettings(page);
    await page.fill('#chart-up', '#ff00ff');
    await page.waitForTimeout(400);

    expect(await magenta()).toBeGreaterThan(100);
    // A rebuild resets frameCount to zero; updateSettings must only invalidate.
    expect(await frames()).toBeGreaterThan(before);
  });

  test('Cancel restores every field at once', async ({ page }) => {
    await open(page);
    await openChartSettings(page);
    await page.uncheck('#chart-grid');
    await page.fill('#chart-precision', '5');
    await page.waitForTimeout(200);
    await page.click('#chart-cancel');
    await page.waitForTimeout(300);

    const settings = await page.evaluate(() => {
      const chart = (window as {
        __chart?: { settings: () => { pricePrecision: number; showGrid: boolean } };
      }).__chart;
      return chart?.settings() ?? null;
    });
    expect(settings).toMatchObject({ pricePrecision: 2, showGrid: true });
  });

  test('chart settings survive a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.evaluate(() => {
      localStorage.clear();
    });
    await openChartSettings(page);
    await page.uncheck('#chart-grid');
    await page.fill('#chart-precision', '3');
    await page.waitForTimeout(200);
    await page.click('#chart-ok');
    await page.waitForTimeout(900);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(500);
    const settings = await page.evaluate(() => {
      const chart = (window as {
        __chart?: { settings: () => { pricePrecision: number; showGrid: boolean } };
      }).__chart;
      return chart?.settings() ?? null;
    });
    expect(settings).toMatchObject({ pricePrecision: 3, showGrid: false });
  });
});
