/**
 * Phase 3 — visual regression + spatial integrity.
 *
 * Pixels alone don't localise a bug, so every scenario pairs a screenshot with
 * programmatic assertions read back from the geometry the renderer actually used
 * (`window.__chartGeometry()`). A screenshot says "something changed"; the geometry
 * assertions say what.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

interface CandleDump {
  readonly index: number;
  readonly centreX: number;
  readonly width: number;
  readonly mode: 'body' | 'line';
}

interface GeometryDump {
  readonly dpr: number;
  readonly plot: { left: number; top: number; width: number; height: number };
  readonly backingStore: Record<string, { width: number; height: number }>;
  readonly cssSize: { width: number; height: number };
  readonly visible: { from: number; to: number; count: number };
  readonly candles: readonly CandleDump[];
  readonly frameCount: number;
}

/** Loads a pinned fixture and waits for a real frame — never a timeout. */
async function openChart(page: Page, query: string): Promise<GeometryDump> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    if (fn === undefined) return false;
    const g = fn() as { frameCount?: number } | null;
    return g !== null && (g.frameCount ?? 0) > 0;
  });
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  return (await page.evaluate(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    return fn === undefined ? null : fn();
  })) as GeometryDump;
}

const FIXTURE = '?seed=7&bars=400&spacing=8&live=0';

test.describe('spatial integrity', () => {
  test('candles never overlap horizontally (RENDER_ALGORITHMS §6)', async ({ page }) => {
    const g = await openChart(page, FIXTURE);
    expect(g.candles.length).toBeGreaterThan(10);

    const sorted = [...g.candles].sort((a, b) => a.centreX - b.centreX);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      // Body spans centreX ± width/2; the spec demands at least 1px of gap.
      expect(cur.centreX - cur.width / 2).toBeGreaterThanOrEqual(
        prev.centreX + prev.width / 2 + 1 - 1e-9,
      );
    }
  });

  test('body width is odd and positive so the wick centres', async ({ page }) => {
    const g = await openChart(page, FIXTURE);
    for (const c of g.candles) {
      expect(c.width % 2).toBe(1);
      expect(c.width).toBeGreaterThanOrEqual(1);
    }
  });

  test('DPR backing store matches round(cssSize * dpr) (§1)', async ({ page }) => {
    const g = await openChart(page, FIXTURE);
    expect(g.dpr).toBe(2);
    for (const [layer, size] of Object.entries(g.backingStore)) {
      expect(size.width, `${layer} backing width`).toBe(Math.round(g.cssSize.width * g.dpr));
      expect(size.height, `${layer} backing height`).toBe(Math.round(g.cssSize.height * g.dpr));
    }
  });

  test('the chart never forces a page scrollbar', async ({ page }) => {
    await openChart(page, FIXTURE);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
  });

  test('no DOM node represents a chart primitive (root mandate #1)', async ({ page }) => {
    await openChart(page, FIXTURE);
    // The plot may contain canvases and nothing else.
    const tags = await page.evaluate(() => {
      const host = document.querySelector('#chart');
      if (host === null) return ['MISSING'];
      return [...host.querySelectorAll('*')].map((el) => el.tagName);
    });
    expect(new Set(tags)).toEqual(new Set(['CANVAS']));
    expect(tags.length).toBe(4);
  });

  test('the series layer actually paints pixels', async ({ page }) => {
    // The guard that matters. A blank canvas satisfies every geometry assertion above
    // AND matches a self-generated screenshot baseline, so the first Phase 3 run went
    // green against four blank PNGs. Reading the backing store back is the only check
    // that distinguishes "computed correct geometry" from "actually drew something".
    await openChart(page, FIXTURE);
    const painted = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="series"]');
      if (canvas === null) return -1;
      const ctx = canvas.getContext('2d');
      if (ctx === null) return -1;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let n = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) n++;
      return n;
    });
    // 400 candles across a 1212px plot cannot plausibly paint fewer than 10k device px.
    expect(painted).toBeGreaterThan(10_000);
  });

  test('the three fixtures render visibly different charts', async ({ page }) => {
    // Guards against every screenshot collapsing to the same blank image: if spacing
    // 2 / 8 / 32 produce identical pixels, the renderer is not reacting to view state.
    const hashes: string[] = [];
    for (const spacing of [2, 8, 32]) {
      await openChart(page, `?seed=7&bars=400&spacing=${String(spacing)}&live=0`);
      const hash = await page.evaluate(() => {
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="series"]',
        );
        if (canvas === null) return 'missing';
        const ctx = canvas.getContext('2d');
        if (ctx === null) return 'no-ctx';
        const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        let h = 2_166_136_261;
        for (let i = 0; i < data.length; i += 97) {
          h ^= data[i];
          h = Math.imul(h, 16_777_619);
        }
        return String(h >>> 0);
      });
      hashes.push(hash);
    }
    expect(new Set(hashes).size).toBe(3);
  });

  test('visible range is clamped inside the series (§5)', async ({ page }) => {
    const g = await openChart(page, FIXTURE);
    expect(g.visible.from).toBeGreaterThanOrEqual(0);
    expect(g.visible.to).toBeLessThanOrEqual(399);
    expect(g.visible.count).toBe(g.candles.length);
  });
});

test.describe('screenshots', () => {
  test('candles-1m', async ({ page }) => {
    await openChart(page, FIXTURE);
    await expect(page.locator('#chart')).toHaveScreenshot('candles-1m.png');
  });

  test('zoomed-in', async ({ page }) => {
    await openChart(page, '?seed=7&bars=400&spacing=32&live=0');
    await expect(page.locator('#chart')).toHaveScreenshot('zoomed-in.png');
  });

  test('zoomed-out-line-mode', async ({ page }) => {
    const g = await openChart(page, '?seed=7&bars=400&spacing=2&live=0');
    // Below 3px of spacing §6 switches to a 1px high/low line.
    for (const c of g.candles) expect(c.mode).toBe('line');
    await expect(page.locator('#chart')).toHaveScreenshot('zoomed-out-line-mode.png');
  });

  test('full-page has no layout overflow', async ({ page }) => {
    await openChart(page, FIXTURE);
    await expect(page).toHaveScreenshot('full-page.png', { fullPage: true });
  });
});
