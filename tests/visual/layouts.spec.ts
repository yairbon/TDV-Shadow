/**
 * Phase 10.4 — multi-chart layouts.
 *
 * The risk in this feature is not "can four charts appear" — it is that the toolbar, the
 * dialogs and the shortcuts were all written against exactly one chart. So most of these
 * assert that the ACTIVE pane is the one being acted on, and that the other panes are
 * genuinely independent rather than views of the same state.
 */

import { expect, test, type Page } from '@playwright/test';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(300);
}

async function setLayout(page: Page, layout: string): Promise<void> {
  await page.selectOption('#layout-pick', layout);
  await page.waitForTimeout(600);
}

const paneCount = (page: Page): Promise<number> => page.locator('#panes .pane').count();

const activeIndex = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const node = document.querySelector('#panes .pane.active');
    return node instanceof HTMLElement ? (node.dataset['pane'] ?? '?') : 'none';
  });

/** Canvas count inside one pane — four layers means a live chart. */
const layersIn = (page: Page, index: number): Promise<number> =>
  page.locator(`#panes .pane[data-pane="${String(index)}"] canvas`).count();

async function clickPane(page: Page, index: number): Promise<void> {
  const box = await page.locator(`#panes .pane[data-pane="${String(index)}"]`).boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click((box?.x ?? 0) + 60, (box?.y ?? 0) + 60);
  await page.waitForTimeout(250);
}

test.describe('multi-chart layouts', () => {
  test('a single chart is the DOM it always was', async ({ page }) => {
    // The whole refactor is only safe if the one-pane case is unchanged: pane 0 reuses
    // the existing #chart element rather than replacing it.
    await open(page);
    expect(await paneCount(page)).toBe(1);
    expect(await page.locator('#chart[data-pane="0"]').count()).toBe(1);
    expect(await layersIn(page, 0)).toBe(4);
  });

  test('each layout creates the right number of live charts', async ({ page }) => {
    await open(page);
    for (const [layout, count] of [
      ['2h', 2],
      ['2v', 2],
      ['4', 4],
      ['1', 1],
    ] as const) {
      await setLayout(page, layout);
      expect(await paneCount(page), layout).toBe(count);
      for (let i = 0; i < count; i++) {
        expect(await layersIn(page, i), `${layout} pane ${String(i)}`).toBe(4);
      }
    }
  });

  test('panes tile without overlapping', async ({ page }) => {
    await open(page);
    await setLayout(page, '4');
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll('#panes .pane')].map((node) => {
        const r = node.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      }),
    );
    expect(boxes).toHaveLength(4);
    for (const box of boxes) {
      expect(box.w).toBeGreaterThan(100);
      expect(box.h).toBeGreaterThan(100);
    }
    // Two columns, two rows: exactly two distinct left edges and two distinct tops.
    expect(new Set(boxes.map((b) => Math.round(b.x))).size).toBe(2);
    expect(new Set(boxes.map((b) => Math.round(b.y))).size).toBe(2);
  });

  test('clicking a pane makes it active', async ({ page }) => {
    await open(page);
    await setLayout(page, '4');
    expect(await activeIndex(page)).toBe('0');

    await clickPane(page, 2);
    expect(await activeIndex(page)).toBe('2');
    await clickPane(page, 1);
    expect(await activeIndex(page)).toBe('1');
  });

  test('the symbol picker retargets to the active pane', async ({ page }) => {
    // The load-bearing one: the toolbar was written against a single chart, and every
    // handler still is. It works because the pane under the pointer becomes active first.
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.selectOption('#symbol-pick', 'AAPL');
    await page.waitForTimeout(500);

    const symbols = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('#panes .pane canvas[data-layer="grid"]')];
      return nodes.length;
    });
    expect(symbols).toBe(2);

    // Pane 1 holds AAPL; pane 0 must be untouched.
    await clickPane(page, 1);
    const active = await page.evaluate(() => {
      const chart = (window as { __chart?: { series: { get: () => { symbol: string } } } }).__chart;
      return chart?.series.get().symbol ?? '';
    });
    expect(active).toBe('AAPL');

    await clickPane(page, 0);
    const other = await page.evaluate(() => {
      const chart = (window as { __chart?: { series: { get: () => { symbol: string } } } }).__chart;
      return chart?.series.get().symbol ?? '';
    });
    expect(other).toBe('DEMO');
  });

  test('panes keep independent views', async ({ page }) => {
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.evaluate(() => {
      (window as { __chart?: { view: { setBarSpacing: (s: number) => void } } }).__chart?.view.setBarSpacing(
        40,
      );
    });
    await page.waitForTimeout(300);
    const paneOne = await page.evaluate(() => {
      const chart = (window as { __chart?: { view: { get: () => { barSpacing: number } } } }).__chart;
      return chart?.view.get().barSpacing ?? 0;
    });
    expect(paneOne).toBeCloseTo(40, 3);

    await clickPane(page, 0);
    const paneZero = await page.evaluate(() => {
      const chart = (window as { __chart?: { view: { get: () => { barSpacing: number } } } }).__chart;
      return chart?.view.get().barSpacing ?? 0;
    });
    expect(paneZero).not.toBeCloseTo(40, 3);
  });

  test('a drawing lands in the pane it was drawn in', async ({ page }) => {
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.keyboard.press('Alt+h');
    await page.waitForTimeout(150);

    const box = await page.locator('#panes .pane[data-pane="1"]').boundingBox();
    await page.mouse.click((box?.x ?? 0) + 150, (box?.y ?? 0) + 150);
    await page.waitForTimeout(300);

    // Disarm before clicking anywhere else: the armed tool is GLOBAL, so a click meant
    // to change panes would otherwise place a second drawing — which it did, and the
    // failure looked exactly like the drawing leaking across panes.
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    // Pane 1 is active and holds the drawing.
    const onActive = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { list: () => readonly unknown[] } } }).__chart;
      return chart?.drawings.list().length ?? -1;
    });
    expect(onActive).toBe(1);

    await clickPane(page, 0);
    const onOther = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { list: () => readonly unknown[] } } }).__chart;
      return chart?.drawings.list().length ?? -1;
    });
    expect(onOther).toBe(0);
  });

  test('shrinking the layout disposes the panes it drops', async ({ page }) => {
    await open(page);
    await setLayout(page, '4');
    await clickPane(page, 3);
    expect(await activeIndex(page)).toBe('3');

    await setLayout(page, '1');
    expect(await paneCount(page)).toBe(1);
    // The active pane cannot be one that no longer exists.
    expect(await activeIndex(page)).toBe('0');
    const errors = await page.evaluate(() => (window as { __errors?: string[] }).__errors ?? []);
    expect(errors).toEqual([]);
  });

  test('the crosshair syncs by bar index, not by pixel', async ({ page }) => {
    // Panes can be at different zooms, so a shared pixel would point at unrelated bars.
    await open(page);
    await setLayout(page, '2h');
    await page.evaluate(() => {
      (window as { __chart?: { view: { setBarSpacing: (s: number) => void } } }).__chart?.view.setBarSpacing(
        30,
      );
    });
    await page.waitForTimeout(300);

    const box = await page.locator('#panes .pane[data-pane="0"]').boundingBox();
    await page.mouse.move((box?.x ?? 0) + 200, (box?.y ?? 0) + 200);
    await page.waitForTimeout(300);

    const inkOnOther = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '#panes .pane[data-pane="1"] canvas[data-layer="crosshair"]',
      );
      const ctx = canvas?.getContext('2d') ?? null;
      if (canvas === null || ctx === null) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 40) count++;
      return count;
    });
    expect(inkOnOther).toBeGreaterThan(50);
  });

  test('the layout and each pane symbol survive a reload', async ({ page }) => {
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.selectOption('#symbol-pick', 'AAPL');
    await page.waitForTimeout(1000);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(800);

    expect(await paneCount(page)).toBe(2);
    await clickPane(page, 1);
    const restored = await page.evaluate(() => {
      const chart = (window as { __chart?: { series: { get: () => { symbol: string } } } }).__chart;
      return chart?.series.get().symbol ?? '';
    });
    expect(restored).toBe('AAPL');
  });
});
