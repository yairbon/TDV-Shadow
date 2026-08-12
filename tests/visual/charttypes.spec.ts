/**
 * Phase 10.3 — the resampling chart types, in the picker at last.
 *
 * Renko, Kagi, Point & Figure, Line Break and Range were built and unit-tested but kept
 * out of the UI because they index their own bar space while the axis labelled from the
 * source series. These tests are about that seam, not about the transforms themselves —
 * the transforms already have unit tests, and none of those would have noticed an axis
 * labelling brick 40 as if it were minute 40.
 */

import { expect, test, type Page } from '@playwright/test';

const RESAMPLING = ['renko', 'kagi', 'point-and-figure', 'line-break', 'range'] as const;
const PRESERVING = ['candles', 'heikin-ashi', 'line', 'area'] as const;

async function open(page: Page, query = 'seed=7&bars=800&live=0'): Promise<void> {
  await page.goto(`/?${query}`);
  await page.waitForFunction(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    const g = fn === undefined ? null : (fn() as { frameCount?: number } | null);
    return g !== null && (g.frameCount ?? 0) > 0;
  });
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(300);
}

async function setType(page: Page, type: string): Promise<void> {
  await page.selectOption('#chart-type', type);
  await page.waitForTimeout(400);
}

/** Bar count in the index space the renderer actually used for the last frame. */
const renderedCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    const g = fn === undefined ? null : (fn() as { barCount?: number } | null);
    return g?.barCount ?? -1;
  });

const sourceCount = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const chart = (window as { __chart?: { series: { get: () => { bars: readonly unknown[] } } } })
      .__chart;
    return chart?.series.get().bars.length ?? 0;
  });

const seriesInk = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="series"]');
    const ctx = canvas?.getContext('2d') ?? null;
    if (canvas === null || ctx === null) return 0;
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 128) count++;
    return count;
  });

test.describe('resampling chart types', () => {
  test('all fourteen types are offered', async ({ page }) => {
    await open(page);
    const options = await page.$$eval('#chart-type option', (nodes) =>
      nodes.map((n) => (n as HTMLOptionElement).value),
    );
    for (const type of [...PRESERVING, ...RESAMPLING]) expect(options).toContain(type);
    expect(options).toHaveLength(14);
  });

  for (const type of RESAMPLING) {
    test(`${type} paints something`, async ({ page }) => {
      // The bar that was never cleared before: these types were unreachable, so "does it
      // draw at all through the real app" had never been asserted for any of them.
      await open(page);
      await setType(page, type);
      expect(await seriesInk(page)).toBeGreaterThan(500);
      const errors = await page.evaluate(() => (window as { __errors?: string[] }).__errors ?? []);
      expect(errors).toEqual([]);
    });
  }

  test('a resampling type renders in its own index space', async ({ page }) => {
    await open(page);
    const source = await sourceCount(page);
    expect(source).toBe(800);

    await setType(page, 'renko');
    const bricks = await renderedCount(page);
    // Renko emits a brick per completed price move, so the count must differ from the
    // source — if it matched, the transform was being ignored.
    expect(bricks).toBeGreaterThan(0);
    expect(bricks).not.toBe(source);
    // The source series is untouched: this is a view, not a mutation.
    expect(await sourceCount(page)).toBe(source);
  });

  test('the axis labels come from the derived bars, not the source index', async ({ page }) => {
    // The exact reason these were excluded. Both types below have FEWER bars than the
    // source, so a source-indexed axis would run off the end of the plot.
    await open(page);
    await setType(page, 'renko');
    const geometry = await page.evaluate(() => {
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      return fn === undefined
        ? null
        : (fn() as {
            plot: { left: number; width: number };
            candles: { centreX: number }[];
            visible: { from: number; to: number };
          } | null);
    });
    expect(geometry).not.toBeNull();
    const plot = geometry?.plot ?? { left: 0, width: 0 };
    for (const candle of geometry?.candles ?? []) {
      expect(candle.centreX).toBeGreaterThanOrEqual(plot.left - plot.width);
      expect(candle.centreX).toBeLessThanOrEqual(plot.left + plot.width * 2);
    }
    expect(geometry?.visible.to).toBeLessThan(await sourceCount(page));
  });

  test('jump-to-latest lands on the last DERIVED bar', async ({ page }) => {
    // Counts have to come from what is rendered: aiming at the source count would scroll
    // far past the end of a shorter derived series.
    await open(page);
    await setType(page, 'renko');
    const rendered = await renderedCount(page);

    await page.evaluate(() => {
      (window as { __chart?: { view: { setScrollPosition: (p: number) => void } } }).__chart?.view.setScrollPosition(
        10,
      );
    });
    await page.waitForTimeout(250);
    await page.evaluate(() => {
      (window as { __chart?: { scrollToRealtime: () => void } }).__chart?.scrollToRealtime();
    });
    await page.waitForTimeout(300);

    const scroll = await page.evaluate(() => {
      const chart = (window as { __chart?: { view: { get: () => { scrollPosition: number } } } })
        .__chart;
      return chart?.view.get().scrollPosition ?? 0;
    });
    expect(scroll).toBeGreaterThan(rendered - 5);
    expect(scroll).toBeLessThan(rendered + 10);
  });

  test('switching back to candles restores the source index space', async ({ page }) => {
    await open(page);
    const source = await sourceCount(page);
    await setType(page, 'renko');
    expect(await renderedCount(page)).not.toBe(source);

    await setType(page, 'candles');
    await page.waitForTimeout(300);
    expect(await renderedCount(page)).toBe(source);
  });

  test('a drawing placed on a resampling type anchors to its own bars', async ({ page }) => {
    // The anchor rule still holds, it just holds against the derived series — which is
    // the honest consequence of rendering in that space, and worth pinning down.
    await open(page);
    await setType(page, 'renko');
    const placed = await page.evaluate(() => {
      const win = window as {
        __tdv?: {
          drawShape: (k: string, a: unknown[], m: string) => unknown;
          listDrawings: () => readonly { readonly anchorPixels: readonly { x: number; y: number }[] }[];
        };
        __chart?: { snapshots: { snapshot: () => { series: { bars: readonly { c: number }[] } } } };
      };
      const bars = win.__chart?.snapshots.snapshot().series.bars ?? [];
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: 2, price: bars[0]?.c ?? 100 },
          { barIndex: 8, price: bars[0]?.c ?? 100 },
        ],
        'off',
      );
      return win.__tdv?.listDrawings() ?? [];
    });
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => {
      const api = (window as {
        __tdv?: {
          listDrawings: () => readonly { readonly anchorPixels: readonly { x: number; y: number }[] }[];
        };
      }).__tdv;
      return api?.listDrawings() ?? [];
    });
    void placed;
    expect(after).toHaveLength(1);
    expect(after[0].anchorPixels).toHaveLength(2);
    expect(Number.isFinite(after[0].anchorPixels[0].x)).toBe(true);
  });

  test('a custom chart type paints in WebGL mode too', async ({ page }) => {
    // The GL series canvas holds a webgl2 context for life, so a Canvas2D chart type
    // cannot go on it. Before this it went nowhere at all and the chart was blank.
    await open(page, 'seed=7&bars=800&live=0&gl=1');
    await setType(page, 'heikin-ashi');

    const painted = await page.evaluate(() => {
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
    expect(painted).toBeGreaterThan(1000);
  });
});
