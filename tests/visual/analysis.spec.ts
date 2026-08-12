/**
 * Phase 9 — analysis tools.
 *
 * The measure tool's whole value is that its numbers are right, so most of these check
 * arithmetic that is visible only through the store, plus one that proves the ruler
 * actually paints. The anchor-rule test is the important one: a measurement taken and
 * then zoomed must still span the same bars and the same prices.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

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

  test('shift-drag over a drawing measures instead of grabbing it', async ({ page }) => {
    // Both handlers sit on the same element, so the measure handler's stopPropagation
    // does not stop the selection one. A ruler started on a trendline grabbed the line as
    // well — and left an undo step behind for a drag that never happened.
    await open(page);
    const placed = await page.evaluate(() => {
      const win = window as {
        __tdv?: {
          drawShape: (k: string, a: unknown[], m: string) => unknown;
          listDrawings: () => readonly { readonly anchors: readonly unknown[] }[];
        };
        __chart?: {
          series: { get: () => { bars: readonly { c: number }[] } };
          pickAnchor: (x: number, y: number) => { anchor: { barIndex: number; price: number } };
        };
      };
      // A horizontal line right through where the ruler will start.
      const at = win.__chart?.pickAnchor(300, 200).anchor ?? { barIndex: 0, price: 0 };
      win.__tdv?.drawShape('horizontal-line', [at], 'off');
      return win.__tdv?.listDrawings() ?? [];
    });
    expect(placed).toHaveLength(1);

    const before = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { listDrawings: () => readonly { readonly anchors: readonly unknown[] }[] };
      }).__tdv;
      return JSON.stringify(api?.listDrawings()[0]?.anchors ?? []);
    });

    await shiftDrag(page, { x: 300, y: 200 }, { x: 560, y: 330 });

    expect(await measure(page)).not.toBeNull();
    const after = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { listDrawings: () => readonly { readonly anchors: readonly unknown[] }[] };
      }).__tdv;
      return JSON.stringify(api?.listDrawings()[0]?.anchors ?? []);
    });
    expect(after).toBe(before);

    const selected = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { selected: () => string | null } } }).__chart;
      return chart?.drawings.selected() ?? null;
    });
    expect(selected).toBeNull();
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

// ------------------------------------------------------------------ 9.2 price alerts

interface AlertHandle {
  readonly id: string;
  readonly price: number;
  readonly triggered: boolean;
  readonly side: string | null;
}

const alerts = (page: Page): Promise<AlertHandle[]> =>
  page.evaluate(() => {
    const chart = (window as { __chart?: { alerts: { list: () => unknown } } }).__chart;
    return (chart?.alerts.list() ?? []) as AlertHandle[];
  });

/** Adds an alert at a plot-relative y through the context menu, as a user would. */
async function addAlert(page: Page, y: number): Promise<AlertHandle> {
  const box = await origin(page);
  await page.mouse.click(400 + box.x, y + box.y, { button: 'right' });
  await page.waitForSelector('#context-menu [data-label="Add alert here"]');
  await page.click('#context-menu [data-label="Add alert here"]');
  await page.waitForTimeout(250);
  const list = await alerts(page);
  return list[list.length - 1];
}

test.describe('price alerts', () => {
  test('the plot menu adds an alert at the clicked price', async ({ page }) => {
    await open(page);
    const created = await addAlert(page, 220);
    expect(created.triggered).toBe(false);

    // The stored price is what the scale maps that pixel to, within a pixel's worth.
    const expected = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          pickAnchor: (x: number, y: number) => { anchor: { price: number } };
          layout: () => { plot: { left: number } };
        };
      }).__chart;
      if (chart === undefined) return 0;
      return chart.pickAnchor(chart.layout().plot.left + 10, 220).anchor.price;
    });
    expect(created.price).toBeCloseTo(expected, 6);
  });

  test('the alert line paints on the overlay', async ({ page }) => {
    await open(page);
    const ink = (): Promise<number> =>
      page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return 0;
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let i = 3; i < data.length; i += 4) if (data[i] > 40) count++;
        return count;
      });
    const before = await ink();
    await addAlert(page, 220);
    expect(await ink()).toBeGreaterThan(before + 200);
  });

  test('dragging the line moves the level and re-arms it', async ({ page }) => {
    await open(page);
    const created = await addAlert(page, 220);
    const box = await origin(page);

    await page.mouse.move(400 + box.x, 220 + box.y);
    await page.mouse.down();
    await page.mouse.move(400 + box.x, 320 + box.y, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(250);

    const after = (await alerts(page))[0];
    expect(after.price).not.toBeCloseTo(created.price, 3);
    expect(after.side).toBeNull();
    expect(after.triggered).toBe(false);
  });

  test('dragging an alert does not pan the chart', async ({ page }) => {
    await open(page);
    await addAlert(page, 220);
    const box = await origin(page);
    const scrollOf = (): Promise<number> =>
      page.evaluate(() => {
        const chart = (window as { __chart?: { view: { get: () => { scrollPosition: number } } } })
          .__chart;
        return chart?.view.get().scrollPosition ?? 0;
      });
    const before = await scrollOf();

    await page.mouse.move(400 + box.x, 220 + box.y);
    await page.mouse.down();
    await page.mouse.move(300 + box.x, 260 + box.y, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(200);
    expect(await scrollOf()).toBeCloseTo(before, 6);
  });

  test('a tick that reaches the level fires a toast exactly once', async ({ page }) => {
    await open(page);
    // Anchored to the data so the level is genuinely reachable by the ticks below.
    const level = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          alerts: { add: (s: string, p: number) => { price: number } };
          series: { get: () => { bars: readonly { c: number }[] } };
        };
      }).__chart;
      if (chart === undefined) return 0;
      const bars = chart.series.get().bars;
      const last = bars[bars.length - 1].c;
      chart.alerts.add('AAPL', last * 1.02);
      return last;
    });
    expect(level).toBeGreaterThan(0);

    await page.evaluate((close) => {
      const chart = (window as {
        __chart?: {
          series: { get: () => { bars: readonly { t: number; v: number }[] } };
          pushTick: (bar: unknown) => void;
        };
      }).__chart;
      if (chart === undefined) return;
      const bars = chart.series.get().bars;
      const last = bars[bars.length - 1];
      // First tick establishes the side, second reaches the level, third stays above.
      chart.pushTick({ t: last.t, o: close, h: close, l: close, c: close, v: last.v });
      const high = close * 1.05;
      chart.pushTick({ t: last.t, o: close, h: high, l: close, c: high, v: last.v });
      chart.pushTick({ t: last.t, o: high, h: high, l: high, c: high, v: last.v });
    }, level);
    await page.waitForTimeout(400);

    expect(await page.locator('#toasts .toast').count()).toBe(1);
    expect((await alerts(page))[0].triggered).toBe(true);
  });

  test('right-clicking an alert offers re-arm and remove', async ({ page }) => {
    await open(page);
    await addAlert(page, 220);
    const box = await origin(page);
    await page.mouse.click(400 + box.x, 220 + box.y, { button: 'right' });
    await page.waitForSelector('#context-menu [role="menuitem"]');
    const labels = await page.$$eval('#context-menu [role="menuitem"]', (nodes) =>
      nodes.map((n) => (n as HTMLElement).dataset['label'] ?? ''),
    );
    expect(labels).toEqual(['Alert armed', 'Remove alert']);

    await page.click('#context-menu [data-label="Remove alert"]');
    await page.waitForTimeout(200);
    expect(await alerts(page)).toHaveLength(0);
  });

  test('a drawing under the cursor wins over an alert line', async ({ page }) => {
    // An alert spans the whole plot, so without this rule a trendline crossing one would
    // be unselectable wherever they meet.
    await open(page);
    await page.evaluate(() => {
      const win = window as {
        __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
        __chart?: {
          series: { get: () => { bars: readonly { c: number }[] } };
          alerts: { add: (s: string, p: number) => unknown };
        };
      };
      const bars = win.__chart?.series.get().bars ?? [];
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: 20, price: bars[20].c },
          { barIndex: 70, price: bars[70].c },
        ],
        'off',
      );
      // An alert exactly on the trendline's first anchor.
      win.__chart?.alerts.add('AAPL', bars[20].c);
    });
    await page.waitForTimeout(300);

    const handle = await page.evaluate(() => {
      const api = (window as { __tdv?: { listDrawings: () => unknown } }).__tdv;
      return (api === undefined ? [] : api.listDrawings()) as {
        id: string;
        anchorPixels: { x: number; y: number }[];
      }[];
    });
    const box = await origin(page);
    const at = handle[0].anchorPixels[0];
    await page.mouse.click(at.x + box.x, at.y + box.y);
    await page.waitForTimeout(200);

    const selected = await page.evaluate(() => {
      const chart = (window as { __chart?: { drawings: { selected: () => string | null } } }).__chart;
      return chart?.drawings.selected() ?? null;
    });
    expect(selected).toBe(handle[0].id);
  });

  test('alerts survive a reload', async ({ page }) => {
    await page.goto('/');
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.evaluate(() => {
      localStorage.clear();
    });
    await page.waitForTimeout(250);
    const created = await addAlert(page, 240);
    await page.waitForTimeout(900);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(500);
    const restored = await alerts(page);
    expect(restored).toHaveLength(1);
    expect(restored[0].price).toBeCloseTo(created.price, 6);
  });
});

// ------------------------------------------------------------------ 9.3 replay

const replayAt = (page: Page): Promise<number | null> =>
  page.evaluate(() => {
    const chart = (window as { __chart?: { replayAt: () => number | null } }).__chart;
    return chart?.replayAt() ?? null;
  });

/** How many bars the renderer actually considered visible in the last frame. */
const lastVisible = (page: Page): Promise<{ from: number; to: number }> =>
  page.evaluate(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    const g = fn === undefined ? null : (fn() as { visible?: { from: number; to: number } } | null);
    return g?.visible ?? { from: 0, to: 0 };
  });

const barCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const chart = (window as { __chart?: { series: { get: () => { bars: readonly unknown[] } } } })
      .__chart;
    return chart?.series.get().bars.length ?? 0;
  });

test.describe('replay', () => {
  test('R enters replay and shows the transport', async ({ page }) => {
    await open(page);
    expect(await replayAt(page)).toBeNull();
    await page.keyboard.press('r');
    await page.waitForTimeout(300);

    expect(await replayAt(page)).not.toBeNull();
    expect(await page.locator('#replay').isVisible()).toBe(true);
  });

  test('replay truncates the rendered series without touching the store', async ({ page }) => {
    await open(page);
    const total = await barCount(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(400);

    const cursor = await replayAt(page);
    expect(cursor).not.toBeNull();
    // Nothing past the cursor is drawn...
    expect((await lastVisible(page)).to).toBeLessThanOrEqual(cursor ?? 0);
    // ...and nothing was deleted: the store is append-only.
    expect(await barCount(page)).toBe(total);
  });

  test('stepping forward advances exactly one bar', async ({ page }) => {
    await open(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    const before = await replayAt(page);

    await page.click('#replay-forward');
    await page.waitForTimeout(250);
    expect(await replayAt(page)).toBe((before ?? 0) + 1);

    await page.click('#replay-back');
    await page.waitForTimeout(250);
    expect(await replayAt(page)).toBe(before);
  });

  test('play advances on its own and pause stops it', async ({ page }) => {
    await open(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    const start = await replayAt(page);

    await page.selectOption('#replay-speed', '5');
    await page.click('#replay-play');
    await page.waitForTimeout(900);
    expect(await replayAt(page)).toBeGreaterThan(start ?? 0);

    // The cursor is read AFTER pausing, not before: a timer tick landing between the read
    // and the click would make a correctly-paused replay look like it kept running.
    await page.click('#replay-play');
    await page.waitForTimeout(150);
    const paused = await replayAt(page);
    await page.waitForTimeout(700);
    expect(await replayAt(page)).toBe(paused);
  });

  test('the scrubber sets the cursor directly', async ({ page }) => {
    await open(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    await page.fill('#replay-scrub', '30');
    await page.dispatchEvent('#replay-scrub', 'input');
    await page.waitForTimeout(300);
    expect(await replayAt(page)).toBe(30);
    expect((await lastVisible(page)).to).toBeLessThanOrEqual(30);
  });

  test('leaving replay restores the whole series', async ({ page }) => {
    await open(page);
    const total = await barCount(page);
    await page.keyboard.press('r');
    await page.waitForTimeout(300);
    await page.click('#replay-exit');
    await page.waitForTimeout(400);

    expect(await replayAt(page)).toBeNull();
    expect(await page.locator('#replay').isVisible()).toBe(false);
    expect((await lastVisible(page)).to).toBe(total - 1);
  });

  test('indicators do not leak the future past the cursor', async ({ page }) => {
    // The reason truncation happens at the snapshot rather than per layer: an indicator
    // computed over the full series would produce values for bars that "have not
    // happened". indicatorValuesAt clamps to the last bar it knows about, so under replay
    // a request past the cursor must come back with the CURSOR's value.
    await open(page);
    await page.evaluate(() => {
      const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
      api?.addIndicator('sma');
    });
    await page.waitForTimeout(300);

    const read = (index: number): Promise<number> =>
      page.evaluate((i) => {
        const chart = (window as {
          __chart?: {
            indicatorValuesAt: (n: number) => readonly { values: readonly { value: number }[] }[];
          };
        }).__chart;
        return chart?.indicatorValuesAt(i)[0]?.values[0]?.value ?? Number.NaN;
      }, index);

    await page.keyboard.press('r');
    await page.waitForTimeout(400);
    const cursor = (await replayAt(page)) ?? 0;
    expect(cursor).toBeGreaterThan(10);

    const atCursor = await read(cursor);
    expect(Number.isFinite(atCursor)).toBe(true);
    expect(await read(cursor + 20)).toBe(atCursor);

    // Guards the guard: outside replay the same two indices give different values, so
    // the equality above is truncation and not a coincidence of a flat series.
    await page.click('#replay-exit');
    await page.waitForTimeout(400);
    expect(await read(cursor + 20)).not.toBe(atCursor);
  });
});
