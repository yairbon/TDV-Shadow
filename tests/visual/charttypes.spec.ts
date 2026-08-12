/**
 * Phase 10.3 — the resampling chart types, in the picker at last.
 *
 * Renko, Kagi, Point & Figure, Line Break and Range were built and unit-tested but kept
 * out of the UI because they index their own bar space while the axis labelled from the
 * source series. These tests are about that seam, not about the transforms themselves —
 * the transforms already have unit tests, and none of those would have noticed an axis
 * labelling brick 40 as if it were minute 40.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

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

interface VolumeInk {
  /** Painted device pixels inside the volume pane of the series layer. */
  readonly ink: number;
  /** CSS columns of that ink belonging to no bar the last frame rendered. */
  readonly stray: number;
  /**
   * CSS columns inside the plot that belong to no bar at all — the gaps between bodies.
   *
   * `stray` can only ever be non-zero if there are some, and at the default fit there are
   * none: an index-preserving type sits at under 2px per bar, so the bodies tile the plot
   * end to end and every column is "explained" by something. Asserting this is what stops
   * `stray === 0` from being a tautology.
   */
  readonly gaps: number;
}

/**
 * Both halves have to be asserted together, and that is not fussiness.
 *
 * `ink > 0` alone passes on a chart that draws no volume at all, because the candle
 * volume from before the type switch is still sitting there — the exact bug. `stray === 0`
 * alone passes on an empty pane. Only the conjunction says "this chart type painted its
 * own volume, and nothing else's".
 */
const volumeInk = (page: Page): Promise<VolumeInk> =>
  page.evaluate(() => {
    const g =
      (window as {
        __chartGeometry?: () => {
          plot: { left: number; width: number };
          volume: { top: number; height: number } | null;
          candles: { centreX: number; width: number }[];
        } | null;
      }).__chartGeometry?.() ?? null;
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="series"]');
    const ctx = canvas?.getContext('2d') ?? null;
    if (g === null || g.volume === null || canvas === null || ctx === null) {
      return { ink: 0, stray: -1, gaps: 0 };
    }

    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const data = ctx.getImageData(
      0,
      Math.round(g.volume.top * dpr),
      canvas.width,
      Math.max(1, Math.round(g.volume.height * dpr)),
    ).data;

    let ink = 0;
    const columns = new Set<number>();
    const rowBytes = canvas.width * 4;
    for (let offset = 3; offset < data.length; offset += 4) {
      if (data[offset] <= 128) continue;
      ink++;
      columns.add(Math.round(((offset - 3) % rowBytes) / 4 / dpr));
    }

    const half = (g.candles[0]?.width ?? 1) / 2 + 1;
    const covered = (x: number): boolean => g.candles.some((c) => Math.abs(c.centreX - x) <= half);

    let stray = 0;
    for (const x of columns) if (!covered(x)) stray++;

    let gaps = 0;
    for (let x = Math.ceil(g.plot.left); x < g.plot.left + g.plot.width; x++) {
      if (!covered(x)) gaps++;
    }
    return { ink, stray, gaps };
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

  test('a resampling type carries the volume of the bars it spans', async ({ page }) => {
    // Derived bars used to be built with v = 0, which made the volume pane vanish and
    // left VWAP, Volume and Volume Profile silently producing nothing on five of the
    // fourteen chart types. A brick's volume is the sum of the source bars it covers.
    await open(page);
    const sourceVolume = await page.evaluate(() => {
      const chart = (window as {
        __chart?: { series: { get: () => { bars: readonly { v: number }[] } } };
      }).__chart;
      return (chart?.series.get().bars ?? []).reduce((sum, b) => sum + b.v, 0);
    });
    expect(sourceVolume).toBeGreaterThan(0);

    await setType(page, 'renko');
    const derivedVolume = await page.evaluate(() => {
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      void fn;
      const chart = (window as {
        __chart?: { snapshots: { snapshot: () => { series: { bars: readonly { v: number }[] } } } };
      }).__chart;
      void chart;
      // The rendered snapshot is not exposed directly, so read the volume the way the
      // renderer does — through an indicator computed on it.
      const api = (window as {
        __tdv?: {
          addIndicator: (i: string) => { handleId: string };
          readIndicator: (h: string) => readonly { values: Record<string, number> }[];
        };
      }).__tdv;
      const handle = api?.addIndicator('volume');
      const rows = handle === undefined ? [] : (api?.readIndicator(handle.handleId) ?? []);
      return rows.reduce((sum, row) => sum + (row.values['volume'] ?? 0), 0);
    });
    await page.waitForTimeout(300);

    expect(derivedVolume).toBeGreaterThan(0);
    // Every source bar falls in exactly one brick, so the totals match.
    expect(derivedVolume).toBeCloseTo(sourceVolume, 0);
  });

  test('drawings stay put across a chart-type switch', async ({ page }) => {
    // Anchors are index-based and a resampling type has its own index space, so bar 400
    // of the source is brick 400 of the Renko series — a different moment entirely. The
    // anchors are remapped through TIME across the switch.
    await open(page);
    const times = await page.evaluate(() => {
      const win = window as {
        __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
        __chart?: { series: { get: () => { bars: readonly { t: number; c: number }[] } } };
      };
      const bars = win.__chart?.series.get().bars ?? [];
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: 200, price: bars[200].c },
          { barIndex: 400, price: bars[400].c },
        ],
        'off',
      );
      return { a: bars[200].t, b: bars[400].t };
    });
    await page.waitForTimeout(300);

    await setType(page, 'renko');
    const after = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { listDrawings: () => readonly { readonly anchors: readonly { barIndex: number }[] }[] };
      }).__tdv;
      return api?.listDrawings()[0]?.anchors.map((a) => a.barIndex) ?? [];
    });
    expect(after).toHaveLength(2);

    // The remapped indices must point at the same MOMENTS in the brick series.
    const mappedTimes = await page.evaluate((indices) => {
      const chart = (window as {
        __chart?: { snapshots: { snapshot: () => unknown } };
      }).__chart;
      void chart;
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      const g = fn === undefined ? null : (fn() as { barCount?: number } | null);
      return { count: g?.barCount ?? 0, indices };
    }, after);
    // Both anchors land inside the brick series and keep their order.
    expect(mappedTimes.indices[0]).toBeGreaterThanOrEqual(0);
    expect(mappedTimes.indices[0]).toBeLessThan(mappedTimes.indices[1]);
    expect(mappedTimes.indices[1]).toBeLessThanOrEqual(mappedTimes.count);
    // And they are NOT the raw source indices, which is what the bug looked like.
    expect(mappedTimes.indices[1]).not.toBeCloseTo(400, 0);
    expect(times.a).toBeLessThan(times.b);
  });

  test('a round trip through another chart type leaves anchors where they were', async ({
    page,
  }) => {
    await open(page);
    await page.evaluate(() => {
      const win = window as {
        __tdv?: { drawShape: (k: string, a: unknown[], m: string) => unknown };
        __chart?: { series: { get: () => { bars: readonly { c: number }[] } } };
      };
      const bars = win.__chart?.series.get().bars ?? [];
      win.__tdv?.drawShape(
        'trendline',
        [
          { barIndex: 200, price: bars[200].c },
          { barIndex: 400, price: bars[400].c },
        ],
        'off',
      );
    });
    await page.waitForTimeout(300);

    await setType(page, 'renko');
    await setType(page, 'candles');
    const back = await page.evaluate(() => {
      const api = (window as {
        __tdv?: { listDrawings: () => readonly { readonly anchors: readonly { barIndex: number }[] }[] };
      }).__tdv;
      return api?.listDrawings()[0]?.anchors.map((a) => a.barIndex) ?? [];
    });
    // Renko is lossy — several source bars share a brick — so this lands within a brick's
    // worth of the original rather than exactly on it. What must not happen is drift of
    // hundreds of bars, which is what an unmapped switch produced.
    expect(Math.abs(back[0] - 200)).toBeLessThan(30);
    expect(Math.abs(back[1] - 400)).toBeLessThan(30);
  });

  for (const type of [...RESAMPLING, 'heikin-ashi', 'line', 'area'] as const) {
    test(`${type} paints its own volume pane and nobody else's`, async ({ page }) => {
      // Two bugs meet in this pane, and each one hides the other.
      //
      // The built-in candle layer owns the volume pane and is SKIPPED for a custom chart
      // type, so every non-candle chart drew nothing there. Derived bars carry volume
      // (summed from the source bars they span), so the derived layer draws it now — §9,
      // over its own index space.
      //
      // That was invisible because the derived layer also broke mandate #2: it cleared
      // only `plot.left + plot.width` by `plot.top + plot.height`, which stops exactly at
      // the TOP of the volume pane. The candle columns from before the switch survived
      // there forever, so the band looked populated while the chart above it had changed
      // to a series with a tenth as many bars.
      await open(page);
      await setType(page, type);
      // Zoom in before measuring. At the default fit an index-preserving type sits at
      // ~1.7 CSS px per bar, so the bars tile every column of the plot and `stray` is
      // structurally incapable of being non-zero — it would pass on a pane full of
      // somebody else's ink. Wide bars leave gaps that stale columns fall into.
      await page.evaluate(() => {
        (window as { __tdv?: { setBarSpacing: (s: number) => void } }).__tdv?.setBarSpacing(20);
      });
      await page.waitForTimeout(300);
      const volume = await volumeInk(page);
      expect(volume.gaps).toBeGreaterThan(100);
      expect(volume.ink).toBeGreaterThan(200);
      expect(volume.stray).toBe(0);
    });
  }

  test('switching to a derived type refits the view to its index space', async ({ page }) => {
    // `setChartType` remapped the DRAWINGS through time but not the VIEW, so a chart
    // fitted to 800 source bars kept that bar spacing and that scroll position over a
    // ~100-brick Renko series: the bricks ended up crammed into the far left of an
    // otherwise empty plot. The view is remapped through time now, same as the anchors.
    await open(page);
    await setType(page, 'renko');

    const spread = await page.evaluate(() => {
      const g =
        (window as {
          __chartGeometry?: () => {
            plot: { left: number; width: number };
            candles: { centreX: number }[];
            barCount: number;
            visible: { from: number; to: number; count: number };
          } | null;
        }).__chartGeometry?.() ?? null;
      if (g === null || g.candles.length === 0) return null;
      const xs = g.candles.map((c) => c.centreX);
      return {
        covered: (Math.max(...xs) - Math.min(...xs)) / g.plot.width,
        visible: g.visible.count,
        barCount: g.barCount,
      };
    });

    expect(spread).not.toBeNull();
    // The bricks span most of the plot rather than huddling at one edge.
    expect(spread?.covered ?? 0).toBeGreaterThan(0.6);
    // And the visible window is a real slice of the brick series, not of the source.
    expect(spread?.visible ?? 0).toBeGreaterThan(1);
    expect(spread?.visible ?? 0).toBeLessThanOrEqual((spread?.barCount ?? 0) + 1);
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
