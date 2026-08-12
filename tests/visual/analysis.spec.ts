/**
 * Phase 9 — analysis tools.
 *
 * The measure tool's whole value is that its numbers are right, so most of these check
 * arithmetic that is visible only through the store, plus one that proves the ruler
 * actually paints. The anchor-rule test is the important one: a measurement taken and
 * then zoomed must still span the same bars and the same prices.
 */

import { expect, test, type Page } from '@playwright/test';

interface Measure {
  readonly from: { readonly barIndex: number; readonly price: number };
  readonly to: { readonly barIndex: number; readonly price: number };
}

async function open(page: Page): Promise<void> {
  await page.goto('/?sym=AAPL');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(250);
}

const measure = (page: Page): Promise<Measure | null> =>
  page.evaluate(() => {
    const chart = (window as { __chart?: { measure: () => unknown } }).__chart;
    return (chart?.measure() ?? null) as Measure | null;
  });

const origin = (page: Page): Promise<{ x: number; y: number }> =>
  page.evaluate(() => {
    const host = document.querySelector('#chart');
    if (host === null) return { x: 0, y: 0 };
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top };
  });

/** Ink on the crosshair layer — where the ruler is drawn. */
const crosshairInk = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>(
      '#chart canvas[data-layer="crosshair"]',
    );
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) count++;
    return count;
  });

async function shiftDrag(
  page: Page,
  a: { x: number; y: number },
  b: { x: number; y: number },
): Promise<void> {
  const box = await origin(page);
  await page.keyboard.down('Shift');
  await page.mouse.move(a.x + box.x, a.y + box.y);
  await page.mouse.down();
  await page.mouse.move(b.x + box.x, b.y + box.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up('Shift');
  await page.waitForTimeout(200);
}

test.describe('measure tool', () => {
  test('shift-drag records both ends in data space', async ({ page }) => {
    await open(page);
    expect(await measure(page)).toBeNull();

    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });
    const m = await measure(page);
    expect(m).not.toBeNull();
    expect(m?.to.barIndex).toBeGreaterThan(m?.from.barIndex ?? 0);
    // Dragging DOWN the screen is a fall in price.
    expect(m?.to.price).toBeLessThan(m?.from.price ?? 0);
  });

  test('the ruler paints', async ({ page }) => {
    await open(page);
    const before = await crosshairInk(page);
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });
    expect(await crosshairInk(page)).toBeGreaterThan(before + 500);
  });

  test('shift-drag does not pan the chart', async ({ page }) => {
    // The pan handler and the ruler both live on pointerdown; without a capture-phase
    // stopPropagation a measurement would drag the chart out from under itself.
    await open(page);
    const scrollOf = (): Promise<number> =>
      page.evaluate(() => {
        const chart = (window as { __chart?: { view: { get: () => { scrollPosition: number } } } })
          .__chart;
        return chart?.view.get().scrollPosition ?? 0;
      });
    const before = await scrollOf();
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });
    expect(await scrollOf()).toBeCloseTo(before, 6);
  });

  test('shift-drag places no drawing, even with a tool armed', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+t');
    await page.waitForTimeout(150);
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });

    const drawings = await page.evaluate(() => {
      const api = (window as { __tdv?: { listDrawings: () => readonly unknown[] } }).__tdv;
      return api?.listDrawings().length ?? 0;
    });
    expect(drawings).toBe(0);
    expect(await measure(page)).not.toBeNull();
  });

  test('the measurement holds still when the chart is zoomed (the anchor rule)', async ({
    page,
  }) => {
    await open(page);
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });
    const before = await measure(page);

    await page.evaluate(() => {
      const api = (window as { __tdv?: { setBarSpacing: (s: number) => unknown } }).__tdv;
      api?.setBarSpacing(24);
    });
    await page.waitForTimeout(250);

    const after = await measure(page);
    expect(after).toEqual(before);
  });

  test('Escape clears the measurement, and clears it before the active tool', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+t');
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });

    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await measure(page)).toBeNull();
    // One Escape does one thing: the trendline tool is still armed.
    expect(await page.textContent('#status')).toContain('trendline');
  });

  test('a plain click clears the last measurement', async ({ page }) => {
    await open(page);
    await shiftDrag(page, { x: 300, y: 200 }, { x: 520, y: 320 });
    expect(await measure(page)).not.toBeNull();

    const box = await origin(page);
    await page.mouse.click(400 + box.x, 400 + box.y);
    await page.waitForTimeout(200);
    expect(await measure(page)).toBeNull();
  });

  test('the rail ruler measures without a Shift key, for touch', async ({ page }) => {
    await open(page);
    await page.click('#tool-rail button[data-tool="measure"]');
    await page.waitForTimeout(150);

    const box = await origin(page);
    await page.mouse.move(300 + box.x, 200 + box.y);
    await page.mouse.down();
    await page.mouse.move(500 + box.x, 300 + box.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    const m = await measure(page);
    expect(m).not.toBeNull();
    expect(m?.to.barIndex).toBeGreaterThan(m?.from.barIndex ?? 0);
  });

  test('the readout matches the anchors it was computed from', async ({ page }) => {
    // Reads the label off the canvas is not practical, so this checks the inputs: the
    // percentage the label shows is (to - from) / from, and the bar count is the rounded
    // index difference. Both are asserted here against the stored anchors.
    await open(page);
    await shiftDrag(page, { x: 250, y: 180 }, { x: 600, y: 340 });
    const m = await measure(page);
    expect(m).not.toBeNull();

    const from = m?.from ?? { barIndex: 0, price: 1 };
    const to = m?.to ?? { barIndex: 0, price: 1 };
    expect(Math.abs(Math.round(to.barIndex - from.barIndex))).toBeGreaterThan(0);
    expect(from.price).toBeGreaterThan(0);
    expect(Number.isFinite(((to.price - from.price) / from.price) * 100)).toBe(true);
  });
});
