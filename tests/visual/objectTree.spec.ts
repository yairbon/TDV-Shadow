/**
 * The object tree.
 *
 * `Drawing` has carried `visible` and `locked` since the store was written, and both were
 * honoured by the renderer and the pointer layer — but the only way to reach either was
 * the per-drawing context menu, so you had to find the shape before you could hide it.
 * These tests are about the surface, and about it staying in step with the store.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

async function open(page: Page): Promise<void> {
  await page.goto('/?seed=7&bars=400&live=0');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(200);
}

/** Places `n` trendlines plus one horizontal line, so the rows differ from each other. */
async function seed(page: Page, n: number): Promise<void> {
  await page.evaluate((count) => {
    const win = window as {
      __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
      __chart?: { series: { get: () => { bars: readonly { c: number }[] } } };
    };
    const bars = win.__chart?.series.get().bars ?? [];
    for (let i = 0; i < count; i++) {
      const a = 30 + i * 40;
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: a, price: bars[a].c },
          { barIndex: a + 30, price: bars[a + 30].c },
        ],
        'off',
      );
    }
    win.__tdv?.drawShape('horizontal-line', [{ barIndex: 100, price: bars[100].c }], 'off');
  }, n);
  await page.waitForTimeout(300);
}

const overlayInk = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="overlay"]');
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return -1;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let offset = 3; offset < data.length; offset += 4) if (data[offset] > 40) count++;
    return count;
  });

const rows = (page: Page): Promise<number> => page.locator('#object-tree .ot-row').count();

async function openTree(page: Page): Promise<void> {
  await page.click('#objects-open');
  await page.waitForSelector('#object-tree', { state: 'visible' });
}

test.describe('object tree', () => {
  test('lists every drawing on the chart', async ({ page }) => {
    await open(page);
    await seed(page, 3);
    await openTree(page);
    expect(await rows(page)).toBe(4);
    // Newest first: the thing you just drew and cannot find is why you opened this.
    const first = await page.textContent('#object-tree .ot-row:first-child .ot-label');
    expect(first).toBe('Horizontal Line');
  });

  test('says so when there is nothing drawn', async ({ page }) => {
    await open(page);
    await openTree(page);
    expect(await rows(page)).toBe(0);
    expect(await page.locator('#object-tree .ot-empty').count()).toBe(1);
  });

  test('hiding one drawing removes its ink and nothing else’s', async ({ page }) => {
    await open(page);
    await seed(page, 3);
    await openTree(page);
    const all = await overlayInk(page);

    await page.click('#object-tree .ot-row:first-child .ot-icon[data-act="visible"]');
    await page.waitForTimeout(300);
    const one = await overlayInk(page);
    // Less ink, but not none — the other three are still drawn.
    expect(one).toBeLessThan(all);
    expect(one).toBeGreaterThan(0);

    await page.click('#object-tree .ot-row:first-child .ot-icon[data-act="visible"]');
    await page.waitForTimeout(300);
    expect(await overlayInk(page)).toBe(all);
  });

  test('hide all and show all reach every drawing', async ({ page }) => {
    await open(page);
    await seed(page, 3);
    await openTree(page);
    const all = await overlayInk(page);

    await page.click('#object-tree .ot-bulk[data-bulk="hide"]');
    await page.waitForTimeout(300);
    const hidden = await overlayInk(page);
    expect(hidden).toBeLessThan(all);

    await page.click('#object-tree .ot-bulk[data-bulk="show"]');
    await page.waitForTimeout(300);
    expect(await overlayInk(page)).toBe(all);
  });

  test('locking from the tree actually refuses a drag', async ({ page }) => {
    // The flag is only worth setting if the pointer layer honours it, and the store
    // previously rejected every patch on a locked drawing — making `locked` one-way.
    await open(page);
    await seed(page, 1);
    await openTree(page);
    await page.click('#object-tree .ot-bulk[data-bulk="lock"]');
    await page.waitForTimeout(300);

    const before = await page.evaluate(() => {
      const api = (window as {
        __tdv?: {
          listDrawings: () => readonly {
            readonly anchors: readonly { barIndex: number }[];
            readonly anchorPixels: readonly { x: number; y: number }[];
          }[];
        };
      }).__tdv;
      return api?.listDrawings()[0];
    });
    const host = await page.locator('#chart').boundingBox();
    const grab = {
      x: (host?.x ?? 0) + (before?.anchorPixels[0].x ?? 0),
      y: (host?.y ?? 0) + (before?.anchorPixels[0].y ?? 0),
    };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 120, grab.y + 60, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { listDrawings: () => readonly { readonly anchors: readonly { barIndex: number }[] }[] };
      }).__tdv;
      return api?.listDrawings()[0];
    });
    expect(after?.anchors[0].barIndex).toBeCloseTo(before?.anchors[0].barIndex ?? 0, 6);

    // …and unlocking from the tree lets it move again, so the lock is not one-way.
    await page.click('#object-tree .ot-bulk[data-bulk="unlock"]');
    await page.waitForTimeout(300);
    expect(
      await page.locator('#object-tree .ot-row:first-child .ot-icon[data-act="locked"]').getAttribute('aria-pressed'),
    ).toBe('false');
  });

  test('removing a row removes the drawing', async ({ page }) => {
    await open(page);
    await seed(page, 3);
    await openTree(page);
    await page.click('#object-tree .ot-row:first-child .ot-icon[data-act="remove"]');
    await page.waitForTimeout(300);
    expect(await rows(page)).toBe(3);
    expect(
      await page.evaluate(() => {
        const api = (window as { __tdv?: { listDrawings: () => readonly unknown[] } }).__tdv;
        return api?.listDrawings().length ?? -1;
      }),
    ).toBe(3);
  });

  test('follows a drawing added on the canvas while it is open', async ({ page }) => {
    // The tree subscribes to the store, so an edit made anywhere else keeps it honest.
    await open(page);
    await seed(page, 1);
    await openTree(page);
    expect(await rows(page)).toBe(2);

    await seed(page, 1);
    expect(await rows(page)).toBe(4);
  });

  test('an undo puts back what the tree removed', async ({ page }) => {
    await open(page);
    await seed(page, 2);
    await openTree(page);
    await page.click('#object-tree .ot-row:first-child .ot-icon[data-act="remove"]');
    await page.waitForTimeout(300);
    expect(await rows(page)).toBe(2);

    await page.keyboard.press('Control+z');
    await page.waitForTimeout(400);
    expect(await rows(page)).toBe(3);
  });
});
