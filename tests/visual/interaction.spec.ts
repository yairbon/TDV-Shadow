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
