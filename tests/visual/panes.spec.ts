/**
 * Resizable stacked panes.
 *
 * The layout split was a single fixed fraction, so an RSI squashed into 60px stayed
 * squashed. The geometry is unit-tested in `tests/unit/renderer/layout.spec.ts`; this file
 * is about the seam — that a pointer on the gap between panes reaches it at all, that the
 * result is what the geometry promised, and that it survives a reload.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

interface Geometry {
  readonly plot: number;
  readonly volume: number;
  readonly panes: readonly number[];
  readonly dividerY: number;
}

async function open(page: Page): Promise<void> {
  await page.goto('/?seed=7&bars=400&live=0');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.evaluate(() => {
    const api = (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv;
    api?.addIndicator('rsi');
  });
  await page.waitForTimeout(500);
}

const geometry = (page: Page): Promise<Geometry> =>
  page.evaluate(() => {
    const chart = (window as {
      __chart?: {
        layout: () => {
          plot: { top: number; height: number };
          volume: { height: number } | null;
          panes: readonly { height: number }[];
        };
        dividerAt: (y: number, tolerance?: number) => { y: number } | null;
      };
    }).__chart;
    const l = chart?.layout();
    if (l === undefined || chart === undefined) {
      return { plot: -1, volume: -1, panes: [], dividerY: -1 };
    }
    const under = chart.dividerAt(l.plot.top + l.plot.height + 3, 10);
    return {
      plot: Math.round(l.plot.height),
      volume: l.volume === null ? 0 : Math.round(l.volume.height),
      panes: l.panes.map((p) => Math.round(p.height)),
      dividerY: under === null ? -1 : under.y,
    };
  });

/**
 * Drags the first divider by `dy` CSS px, with a sideways component.
 *
 * Sideways deliberately: pan is horizontal, so a perfectly vertical drag cannot reveal an
 * unsuppressed pan no matter how the handlers are wired, and the test that checks for one
 * would pass on a build that never suppressed it. Nobody drags perfectly vertically
 * either.
 */
async function dragDivider(page: Page, dy: number): Promise<void> {
  const before = await geometry(page);
  const host = await page.locator('#chart').boundingBox();
  const x = (host?.x ?? 0) + 400;
  const y = (host?.y ?? 0) + before.dividerY;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + dy, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

test.describe('resizable panes', () => {
  test('the gap between panes is grabbable', async ({ page }) => {
    await open(page);
    const before = await geometry(page);
    expect(before.dividerY).toBeGreaterThan(0);

    const host = await page.locator('#chart').boundingBox();
    await page.mouse.move((host?.x ?? 0) + 400, (host?.y ?? 0) + before.dividerY);
    await page.waitForTimeout(200);
    expect(await page.evaluate(() => document.querySelector<HTMLElement>('#chart')?.style.cursor)).toBe(
      'ns-resize',
    );
  });

  test('dragging moves height between the two panes it separates', async ({ page }) => {
    await open(page);
    const before = await geometry(page);
    await dragDivider(page, -120);
    const after = await geometry(page);

    expect(after.plot).toBeLessThan(before.plot);
    expect(after.volume).toBeGreaterThan(before.volume);
    // Only the pair either side moves; the indicator pane below is untouched.
    expect(after.panes).toEqual(before.panes);
    // And the pair's total is invariant, which is what makes a drag reversible.
    expect(after.plot + after.volume).toBe(before.plot + before.volume);
  });

  test('dragging back restores the original split', async ({ page }) => {
    await open(page);
    const before = await geometry(page);
    await dragDivider(page, -120);
    expect((await geometry(page)).plot).not.toBe(before.plot);

    await dragDivider(page, 120);
    const back = await geometry(page);
    expect(Math.abs(back.plot - before.plot)).toBeLessThanOrEqual(1);
    expect(Math.abs(back.volume - before.volume)).toBeLessThanOrEqual(1);
  });

  test('a drag past the limit clamps instead of inverting a pane', async ({ page }) => {
    await open(page);
    await dragDivider(page, -5000);
    const after = await geometry(page);
    // Nothing collapses or goes negative, and the plot keeps a usable height.
    expect(after.plot).toBeGreaterThan(0);
    expect(after.volume).toBeGreaterThan(0);
    for (const height of after.panes) expect(height).toBeGreaterThan(0);
  });

  test('the dragged split survives a reload', async ({ page }) => {
    await open(page);
    await dragDivider(page, -120);
    const dragged = await geometry(page);

    await page.waitForTimeout(2400);
    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(700);

    const restored = await geometry(page);
    expect(Math.abs(restored.plot - dragged.plot)).toBeLessThanOrEqual(2);
    expect(Math.abs(restored.volume - dragged.volume)).toBeLessThanOrEqual(2);
  });

  test('the dragged split survives a rebuild', async ({ page }) => {
    // `build()` throws the chart away and makes a new one — on a theme toggle as well as a
    // symbol change — so the split has to be mirrored out of the chart, not only read back
    // out of it when saving. Exactly the shape of the bug that destroyed drawings and
    // indicators on a theme toggle.
    await open(page);
    await dragDivider(page, -120);
    const dragged = await geometry(page);

    await page.click('#theme-toggle');
    await page.waitForTimeout(700);

    const after = await geometry(page);
    expect(Math.abs(after.plot - dragged.plot)).toBeLessThanOrEqual(2);
    expect(Math.abs(after.volume - dragged.volume)).toBeLessThanOrEqual(2);
  });

  test('the chart still draws correctly after a resize', async ({ page }) => {
    // The panes are rects the whole renderer reads; a resize that produced an overlapping
    // or out-of-bounds rect would show up here rather than in the geometry numbers.
    await open(page);
    await dragDivider(page, -120);
    const report = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { getIntegrityReport: () => { ok: boolean; outsidePlot: number; painted: number } };
      }).__tdv;
      return api?.getIntegrityReport() ?? { ok: false, outsidePlot: -1, painted: -1 };
    });
    expect(report.outsidePlot).toBe(0);
    expect(report.painted).toBeGreaterThan(1000);
    expect(report.ok).toBe(true);
  });

  test('a drag does not place a drawing or start a pan', async ({ page }) => {
    // The divider sits in the gap between panes, where the pan handler and the drawing
    // placement handler both also live.
    await open(page);
    const scrollBefore = await page.evaluate(() => {
      const chart = (window as { __chart?: { view: { get: () => { scrollPosition: number } } } })
        .__chart;
      return chart?.view.get().scrollPosition ?? 0;
    });
    await dragDivider(page, -100);

    expect(
      await page.evaluate(() => {
        const api = (window as { __tdv?: { listDrawings: () => readonly unknown[] } }).__tdv;
        return api?.listDrawings().length ?? -1;
      }),
    ).toBe(0);
    expect(
      await page.evaluate(() => {
        const chart = (window as { __chart?: { view: { get: () => { scrollPosition: number } } } })
          .__chart;
        return chart?.view.get().scrollPosition ?? 0;
      }),
    ).toBeCloseTo(scrollBefore, 6);
  });
});
