/**
 * Phase 7 — direct manipulation.
 *
 * These are the tests that would have caught the original gap: `hitTest.ts` had 41
 * passing unit tests and zero call sites, so drawings could not be selected at all while
 * every test was green. Unit tests prove the geometry; only these prove it is reachable.
 *
 * Coordinates: anchor pixels are relative to #chart, but the mouse takes VIEWPORT
 * coordinates and #chart is offset by the top bar and the tool rail. Forgetting that
 * offset makes every drag silently miss and look like broken hit testing.
 */

import { expect, test, type Page } from '@playwright/test';

interface Anchor {
  readonly barIndex: number;
  readonly price: number;
}
interface Handle {
  readonly id: string;
  readonly anchors: readonly Anchor[];
  readonly anchorPixels: readonly { readonly x: number; readonly y: number }[];
}

async function open(page: Page): Promise<void> {
  await page.goto('/?sym=AAPL');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(200);
}

/** #chart-relative point -> viewport point. */
async function toViewport(page: Page, point: { x: number; y: number }): Promise<{ x: number; y: number }> {
  const box = await page.evaluate(() => {
    const host = document.querySelector('#chart');
    if (host === null) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });
  return { x: point.x + box.x, y: point.y + box.y };
}

const list = (page: Page): Promise<Handle[]> =>
  page.evaluate(() => {
    const api = (window as { __tdv?: { listDrawings: () => unknown } }).__tdv;
    return (api === undefined ? [] : api.listDrawings()) as Handle[];
  });

async function placeTrendline(page: Page): Promise<Handle> {
  await page.evaluate(() => {
    const api = (window as {
      __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
    }).__tdv;
    api?.drawShape(
      'trendline',
      [
        { barIndex: 20, price: 260 },
        { barIndex: 70, price: 300 },
      ],
      'off',
    );
  });
  await page.waitForTimeout(200);
  return (await list(page))[0];
}

test.describe('selection and dragging', () => {
  test('dragging an endpoint moves only that anchor', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const grab = await toViewport(page, placed.anchorPixels[1]);

    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x - 160, grab.y + 90, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const after = (await list(page))[0];
    expect(after.anchors[0].barIndex).toBeCloseTo(placed.anchors[0].barIndex, 9);
    expect(after.anchors[0].price).toBeCloseTo(placed.anchors[0].price, 9);
    expect(Math.abs(after.anchors[1].barIndex - placed.anchors[1].barIndex)).toBeGreaterThan(1);
  });

  test('the dropped pixel is exactly where the anchor re-projects', async ({ page }) => {
    // The anchor-rule property, driven by the mouse instead of by a unit test: what you
    // dropped is what the scales give back.
    await open(page);
    const placed = await placeTrendline(page);
    const grab = await toViewport(page, placed.anchorPixels[1]);

    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x - 120, grab.y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const after = (await list(page))[0];
    expect(after.anchorPixels[1].x).toBeCloseTo(placed.anchorPixels[1].x - 120, 0);
    expect(after.anchorPixels[1].y).toBeCloseTo(placed.anchorPixels[1].y + 60, 0);
  });

  test('clicking a drawing selects it and empty space clears it', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const onShape = await toViewport(page, placed.anchorPixels[0]);

    await page.mouse.click(onShape.x, onShape.y);
    await page.waitForTimeout(150);
    const selected = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { selected: () => string | null } } }).__chart;
      return chart?.drawings.selected() ?? null;
    });
    expect(selected).toBe(placed.id);

    await page.mouse.click(onShape.x, onShape.y + 220);
    await page.waitForTimeout(150);
    const cleared = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { selected: () => string | null } } }).__chart;
      return chart?.drawings.selected() ?? null;
    });
    expect(cleared).toBeNull();
  });

  test('dragging the body moves every anchor by the same delta', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    // Midpoint of the segment is body, not an anchor handle.
    const mid = {
      x: (placed.anchorPixels[0].x + placed.anchorPixels[1].x) / 2,
      y: (placed.anchorPixels[0].y + placed.anchorPixels[1].y) / 2,
    };
    const grab = await toViewport(page, mid);

    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 80, grab.y - 40, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const after = (await list(page))[0];
    const d0 = after.anchors[0].barIndex - placed.anchors[0].barIndex;
    const d1 = after.anchors[1].barIndex - placed.anchors[1].barIndex;
    expect(d0).toBeCloseTo(d1, 6);
    expect(Math.abs(d0)).toBeGreaterThan(0.5);
  });
});

test.describe('undo and redo', () => {
  test('undo restores the pre-drag anchors exactly', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const grab = await toViewport(page, placed.anchorPixels[1]);

    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x - 140, grab.y + 70, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);

    const after = (await list(page))[0];
    expect(after.anchors[0]).toEqual(placed.anchors[0]);
    expect(after.anchors[1]).toEqual(placed.anchors[1]);
  });

  test('delete then undo brings the drawing back', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const onShape = await toViewport(page, placed.anchorPixels[0]);

    await page.mouse.click(onShape.x, onShape.y);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(200);
    expect(await list(page)).toHaveLength(0);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);
    const restored = await list(page);
    expect(restored).toHaveLength(1);
    expect(restored[0].anchors[1]).toEqual(placed.anchors[1]);
  });

  test('redo re-applies what undo reverted', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const grab = await toViewport(page, placed.anchorPixels[1]);

    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x - 100, grab.y + 50, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    const dragged = (await list(page))[0];

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(250);

    const after = (await list(page))[0];
    expect(after.anchors[1].barIndex).toBeCloseTo(dragged.anchors[1].barIndex, 6);
  });
});

test.describe('keyboard', () => {
  test('Alt+T arms the trendline tool and Escape disarms it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+t');
    await page.waitForTimeout(150);
    expect(await page.textContent('#status')).toContain('trendline');

    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    expect(await page.textContent('#status')).not.toContain('trendline');
  });

  test('typing in the search box is never stolen by shortcuts', async ({ page }) => {
    // Delete inside a text field must edit text, not delete a drawing.
    await open(page);
    await placeTrendline(page);
    await page.click('#symbol-button');
    await page.waitForTimeout(150);
    await page.fill('#search-input', 'AAP');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150);
    expect(await page.inputValue('#search-input')).toBe('AA');
    expect(await list(page)).toHaveLength(1);
  });
});

// ------------------------------------------------------------------ 7.3 context menus

const menuLabels = (page: Page): Promise<string[]> =>
  page.$$eval('#context-menu [role="menuitem"]', (nodes) =>
    nodes.map((n) => (n as HTMLElement).dataset['label'] ?? ''),
  );

async function rightClick(page: Page, point: { x: number; y: number }): Promise<void> {
  const p = await toViewport(page, point);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await page.waitForSelector('#context-menu [role="menuitem"]');
}

/** Gutter rects come from the live layout, not from guessed pixel offsets. */
const gutters = (page: Page): Promise<{ price: { x: number; y: number }; time: { x: number; y: number } }> =>
  page.evaluate(() => {
    const chart = (window as {
      __chart?: {
        layout: () => {
          priceGutter: { left: number; top: number; width: number; height: number };
          timeGutter: { left: number; top: number; width: number; height: number };
        };
      };
    }).__chart;
    if (chart === undefined) throw new Error('no chart');
    const l = chart.layout();
    return {
      price: { x: l.priceGutter.left + l.priceGutter.width / 2, y: l.priceGutter.top + 60 },
      time: { x: l.timeGutter.left + l.timeGutter.width / 2, y: l.timeGutter.top + l.timeGutter.height / 2 },
    };
  });

test.describe('context menus', () => {
  test('right-clicking a drawing offers its own actions and selects it', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[0]);

    expect(await menuLabels(page)).toEqual([
      'Clone',
      'Lock',
      'Bring to front',
      'Send to back',
      'Remove',
    ]);
    const selected = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { selected: () => string | null } } }).__chart;
      return chart?.drawings.selected() ?? null;
    });
    expect(selected).toBe(placed.id);
  });

  test('right-click does not drag the shape it opens the menu on', async ({ page }) => {
    // The selection handler runs on pointerdown, which fires for the right button too.
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[1]);
    const after = (await list(page))[0];
    expect(after.anchors).toEqual(placed.anchors);
  });

  test('Clone adds an offset copy', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[0]);
    await page.click('#context-menu [data-label="Clone"]');
    await page.waitForTimeout(200);

    const all = await list(page);
    expect(all).toHaveLength(2);
    expect(all[1].anchors[0].barIndex).toBeCloseTo(placed.anchors[0].barIndex + 3, 6);
    expect(all[1].anchors[0].price).toBeCloseTo(placed.anchors[0].price, 6);
  });

  test('Lock refuses a drag and can be lifted again', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[0]);
    await page.click('#context-menu [data-label="Lock"]');
    await page.waitForTimeout(150);

    // Anchor pixels are re-read before every gesture: a drag on a locked drawing falls
    // through to the pan handler, exactly as it does in TradingView, so the shape stays
    // put in DATA space while its pixels move with the chart.
    const drag = async (): Promise<void> => {
      const current = (await list(page))[0];
      const grab = await toViewport(page, current.anchorPixels[1]);
      await page.mouse.move(grab.x, grab.y);
      await page.mouse.down();
      await page.mouse.move(grab.x - 150, grab.y + 80, { steps: 6 });
      await page.mouse.up();
      await page.waitForTimeout(200);
    };

    await drag();
    expect((await list(page))[0].anchors).toEqual(placed.anchors);

    // Locking must be reversible — the store used to reject every patch on a locked
    // drawing, `locked: false` included.
    const locked = (await list(page))[0];
    await rightClick(page, locked.anchorPixels[0]);
    expect(await menuLabels(page)).toContain('Unlock');
    await page.click('#context-menu [data-label="Unlock"]');
    await page.waitForTimeout(150);

    await drag();
    expect((await list(page))[0].anchors).not.toEqual(placed.anchors);
  });

  test('Delete leaves a locked drawing alone', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[0]);
    await page.click('#context-menu [data-label="Lock"]');
    await page.waitForTimeout(150);
    await page.keyboard.press('Delete');
    await page.waitForTimeout(150);
    expect(await list(page)).toHaveLength(1);
  });

  test('Send to back changes the paint order', async ({ page }) => {
    await open(page);
    const first = await placeTrendline(page);
    await page.evaluate(() => {
      const api = (window as { __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown } }).__tdv;
      api?.drawShape('rectangle', [
        { barIndex: 30, price: 250 },
        { barIndex: 60, price: 290 },
      ], 'off');
    });
    await page.waitForTimeout(150);
    const before = (await list(page)).map((d) => d.id);
    expect(before[0]).toBe(first.id);

    await rightClick(page, first.anchorPixels[0]);
    await page.click('#context-menu [data-label="Bring to front"]');
    await page.waitForTimeout(200);
    const after = (await list(page)).map((d) => d.id);
    expect(after[after.length - 1]).toBe(first.id);
    expect(after).toHaveLength(before.length);
  });

  test('Remove deletes just that drawing and undo brings it back', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    await rightClick(page, placed.anchorPixels[0]);
    await page.click('#context-menu [data-label="Remove"]');
    await page.waitForTimeout(200);
    expect(await list(page)).toHaveLength(0);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);
    expect(await list(page)).toHaveLength(1);
  });

  test('the plot menu adds an indicator through its submenu', async ({ page }) => {
    await open(page);
    // Somewhere in the plot with no drawing under it.
    await rightClick(page, { x: 320, y: 160 });
    expect(await menuLabels(page)).toContain('Add indicator');

    await page.hover('#context-menu [data-label="Add indicator"]');
    await page.waitForSelector('.ctx:not(#context-menu) [data-label="RSI"]');
    await page.click('.ctx:not(#context-menu) [data-label="RSI"]');
    await page.waitForTimeout(300);

    const indicators = await page.evaluate(() => {
      const api = (window as { __tdv?: { getState: () => { indicators: readonly unknown[] } } }).__tdv;
      return api?.getState().indicators.length ?? 0;
    });
    expect(indicators).toBe(1);
    // The menu closes on selection rather than lingering over the chart.
    expect(await page.locator('#context-menu').isHidden()).toBe(true);
  });

  test('the price gutter menu inverts the scale, reflecting every anchor', async ({ page }) => {
    await open(page);
    const placed = await placeTrendline(page);
    const plot = await page.evaluate(() => {
      const chart = (window as { __chart?: { layout: () => { plot: { top: number; height: number } } } }).__chart;
      return chart?.layout().plot ?? { top: 0, height: 0 };
    });

    const where = await gutters(page);
    await rightClick(page, where.price);
    expect(await menuLabels(page)).toEqual(['Logarithmic', 'Invert price scale', 'Auto scale']);
    await page.click('#context-menu [data-label="Invert price scale"]');
    await page.waitForTimeout(250);

    const after = (await list(page))[0];
    const mirror = (y: number): number => 2 * plot.top + plot.height - y;
    expect(after.anchorPixels[0].y).toBeCloseTo(mirror(placed.anchorPixels[0].y), 3);
    expect(after.anchorPixels[1].y).toBeCloseTo(mirror(placed.anchorPixels[1].y), 3);
    // x is untouched: inversion is a price-axis operation only.
    expect(after.anchorPixels[0].x).toBeCloseTo(placed.anchorPixels[0].x, 6);
  });

  test('the time gutter menu offers time-scale actions only', async ({ page }) => {
    await open(page);
    const where = await gutters(page);
    await rightClick(page, where.time);
    expect(await menuLabels(page)).toEqual(['Fit all bars', 'Go to realtime']);
  });

  test('Escape closes the menu without disarming the active tool', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+t');
    await page.waitForTimeout(150);
    await rightClick(page, { x: 320, y: 160 });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);

    expect(await page.locator('#context-menu').isHidden()).toBe(true);
    expect(await page.textContent('#status')).toContain('trendline');
  });

  test('the menu is clamped inside the viewport near an edge', async ({ page }) => {
    await open(page);
    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.click(size.width - 8, size.height - 8, { button: 'right' });
    await page.waitForSelector('#context-menu [role="menuitem"]');
    const box = await page.locator('#context-menu').boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(size.width);
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(size.height);
  });
});
