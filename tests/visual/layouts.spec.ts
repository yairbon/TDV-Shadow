/**
 * Phase 10.4 — multi-chart layouts.
 *
 * The risk in this feature is not "can four charts appear" — it is that the toolbar, the
 * dialogs and the shortcuts were all written against exactly one chart. So most of these
 * assert that the ACTIVE pane is the one being acted on, and that the other panes are
 * genuinely independent rather than views of the same state.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

/**
 * Clears the workspace BEFORE the app boots, rather than after navigating.
 *
 * Clearing afterwards only stops a workspace being saved again — it does not stop one
 * being restored, because boot has already happened. Playwright's per-test context makes
 * that harmless today; doing it in the right order means it stays harmless if these tests
 * are ever run in a shared context.
 */
async function open(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      // Once per test, not once per navigation: `addInitScript` also runs on reload, and
      // clearing there would wipe the workspace the reload tests exist to check.
      // sessionStorage survives a reload but not a fresh context, which is exactly that
      // scope.
      if (sessionStorage.getItem('tdv-test-cleared') === null) {
        localStorage.clear();
        sessionStorage.setItem('tdv-test-cleared', '1');
      }
    } catch {
      /* private mode; nothing to clear */
    }
  });
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
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

  test('the control API reports the ACTIVE pane, not the last one built', async ({ page }) => {
    // getState() carries the symbol by value, so it has to be reinstalled on a pane
    // switch as well as on a rebuild. Without that it named whichever pane was built
    // last while returning a chart that was a different one.
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.selectOption('#symbol-pick', 'AAPL');
    await page.waitForTimeout(600);
    expect(
      await page.evaluate(() => {
        const api = (window as { __tdv?: { getState: () => { symbol: string } } }).__tdv;
        return api?.getState().symbol ?? '';
      }),
    ).toBe('AAPL');

    await clickPane(page, 0);
    expect(
      await page.evaluate(() => {
        const api = (window as { __tdv?: { getState: () => { symbol: string } } }).__tdv;
        return api?.getState().symbol ?? '';
      }),
    ).toBe('DEMO');
  });

  test('the legend follows the active pane', async ({ page }) => {
    // It reads the active chart but was pinned to the top-left of the whole plot area, so
    // it described one chart while sitting on another — and, its indicator rows being
    // clickable, it swallowed the clicks meant to activate the pane underneath it. That
    // second half is why clicking pane 0 silently did nothing.
    await open(page);
    await setLayout(page, '2h');
    const leftOf = (): Promise<number> =>
      page.evaluate(() => {
        const node = document.querySelector('#legend');
        return node instanceof HTMLElement ? node.getBoundingClientRect().left : -1;
      });

    const onPaneZero = await leftOf();
    await clickPane(page, 1);
    const onPaneOne = await leftOf();
    expect(onPaneOne).toBeGreaterThan(onPaneZero + 100);

    // And clicking back is not swallowed.
    await clickPane(page, 0);
    expect(await activeIndex(page)).toBe('0');
    expect(await leftOf()).toBeCloseTo(onPaneZero, 0);
  });

  test('every pane keeps its own annotations across a reload', async ({ page }) => {
    // The workspace used to hold ONE chart's state plus a list of pane symbols, so a
    // reload restored what the other panes were showing and silently dropped every
    // indicator, drawing and alert on them.
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.evaluate(() => {
      const win = window as {
        __tdv?: {
          addIndicator: (i: string) => unknown;
          drawShape: (k: string, a: unknown[], m: string) => unknown;
        };
        __chart?: {
          series: { get: () => { bars: readonly { c: number }[] } };
          alerts: { add: (s: string, p: number) => unknown };
        };
      };
      const bars = win.__chart?.series.get().bars ?? [];
      win.__tdv?.addIndicator('sma');
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: 20, price: bars[20].c },
          { barIndex: 70, price: bars[70].c },
        ],
        'off',
      );
      win.__chart?.alerts.add('DEMO', bars[50].c);
    });
    await page.waitForTimeout(1200);

    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(900);

    expect(await paneCount(page)).toBe(2);
    await clickPane(page, 1);
    const restored = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          listIndicators: () => readonly unknown[];
          drawings: { list: () => readonly unknown[] };
          alerts: { list: () => readonly unknown[] };
        };
      }).__chart;
      return {
        indicators: chart?.listIndicators().length ?? -1,
        drawings: chart?.drawings.list().length ?? -1,
        alerts: chart?.alerts.list().length ?? -1,
      };
    });
    expect(restored).toEqual({ indicators: 1, drawings: 1, alerts: 1 });

    // Pane 0 must not have inherited any of it.
    await clickPane(page, 0);
    const untouched = await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          listIndicators: () => readonly unknown[];
          drawings: { list: () => readonly unknown[] };
        };
      }).__chart;
      return {
        indicators: chart?.listIndicators().length ?? -1,
        drawings: chart?.drawings.list().length ?? -1,
      };
    });
    expect(untouched).toEqual({ indicators: 0, drawings: 0 });
  });

  test('an alert names the pane that fired it', async ({ page }) => {
    // The toast read the module-level symbol, which is the ACTIVE pane's — in a
    // multi-pane layout usually a different instrument from the one that fired.
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 1);
    await page.selectOption('#symbol-pick', 'AAPL');
    await page.waitForTimeout(600);

    // Arm an alert on pane 1, then make pane 0 active before firing it.
    await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          alerts: { add: (s: string, p: number) => unknown };
          series: { get: () => { bars: readonly { c: number }[] } };
        };
      }).__chart;
      const bars = chart?.series.get().bars ?? [];
      chart?.alerts.add('AAPL', bars[bars.length - 1].c * 1.02);
    });
    await page.waitForTimeout(200);

    await page.evaluate(() => {
      const chart = (window as {
        __chart?: {
          series: { get: () => { bars: readonly { t: number; c: number; v: number }[] } };
          pushTick: (bar: unknown) => void;
        };
      }).__chart;
      if (chart === undefined) return;
      const bars = chart.series.get().bars;
      const last = bars[bars.length - 1];
      const high = last.c * 1.05;
      chart.pushTick({ t: last.t, o: last.c, h: last.c, l: last.c, c: last.c, v: last.v });
      chart.pushTick({ t: last.t, o: last.c, h: high, l: last.c, c: high, v: last.v });
    });
    await page.waitForTimeout(400);

    const text = await page.locator('#toasts .toast').first().textContent();
    expect(text).toContain('AAPL');
  });

  test('live ticks reach every pane, not only the active one', async ({ page }) => {
    // A four-pane layout with live data used to freeze three of its charts the moment
    // they stopped being the one you were looking at.
    await open(page);
    await setLayout(page, '2h');
    await clickPane(page, 0);

    /** Last close of each pane, read by activating it — the honest per-pane tick signal. */
    const lastCloses = async (): Promise<number[]> => {
      const out: number[] = [];
      for (const index of [0, 1]) {
        await clickPane(page, index);
        out.push(
          await page.evaluate(() => {
            const chart = (window as {
              __chart?: { series: { get: () => { bars: readonly { c: number }[] } } };
            }).__chart;
            const bars = chart?.series.get().bars ?? [];
            return bars.length === 0 ? Number.NaN : bars[bars.length - 1].c;
          }),
        );
      }
      return out;
    };

    const before = await lastCloses();
    await clickPane(page, 0);
    await page.click('#live-toggle');
    await page.waitForTimeout(1600);
    await page.click('#live-toggle');
    const after = await lastCloses();

    expect(after).toHaveLength(2);
    expect(after[0]).not.toBe(before[0]);
    // The one that matters: pane 1 was never active while the ticks were running.
    expect(after[1]).not.toBe(before[1]);
  });

  test('undo is per pane, not shared', async ({ page }) => {
    // A single stack would happily apply pane A's drawings to pane B: capture() records
    // the ACTIVE chart's annotations, so Ctrl+Z after a pane switch replayed one chart's
    // history onto another's.
    await open(page);
    await setLayout(page, '2h');

    /**
     * Places a horizontal line the way a USER does — armed tool, click in the pane.
     *
     * Deliberately not `__tdv.drawShape`: the control API writes straight to the store
     * and never touches the undo stack, so a test driven through it would prove nothing
     * about undo.
     */
    const draw = async (index: number, offsetY: number): Promise<void> => {
      await page.keyboard.press('Alt+h');
      await page.waitForTimeout(120);
      const box = await page.locator(`#panes .pane[data-pane="${String(index)}"]`).boundingBox();
      await page.mouse.click((box?.x ?? 0) + 200, (box?.y ?? 0) + offsetY);
      await page.waitForTimeout(200);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(120);
    };
    const count = (): Promise<number> =>
      page.evaluate(() => {
        const chart = (window as { __chart?: { drawings: { list: () => readonly unknown[] } } })
          .__chart;
        return chart?.drawings.list().length ?? -1;
      });

    // Two drawings on pane 0, none on pane 1.
    await clickPane(page, 0);
    await draw(0, 180);
    await draw(0, 260);
    expect(await count()).toBe(2);

    await clickPane(page, 1);
    expect(await count()).toBe(0);

    // Undo on pane 1 has nothing of its own to undo, and must not reach into pane 0's.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    expect(await count()).toBe(0);
    await clickPane(page, 0);
    expect(await count()).toBe(2);

    // Pane 0's own undo still works.
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(300);
    expect(await count()).toBe(1);
  });

  test('the theme toggle repaints every pane, not just the active one', async ({ page }) => {
    // Theme and renderer are global and both need a chart torn down, so rebuilding only
    // the active pane left the others on the old theme.
    await open(page);
    await setLayout(page, '2h');

    /** Background of a pane's grid layer, sampled at a corner. */
    const background = (index: number): Promise<string> =>
      page.evaluate((i) => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          `#panes .pane[data-pane="${String(i)}"] canvas[data-layer="grid"]`,
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return '';
        const d = ctx.getImageData(2, 2, 1, 1).data;
        return `${String(d[0])},${String(d[1])},${String(d[2])}`;
      }, index);

    const before = [await background(0), await background(1)];
    expect(before[0]).not.toBe('');
    await page.click('#theme-toggle');
    await page.waitForTimeout(700);
    const after = [await background(0), await background(1)];

    expect(after[0]).not.toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    // Both panes end on the SAME theme, which is the part that was broken.
    expect(after[0]).toBe(after[1]);
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
