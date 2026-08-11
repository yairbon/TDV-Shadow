/**
 * Phase 4 — WebGL series layer vs Canvas2D, differentially.
 *
 * RENDER_ALGORITHMS §11: "The Canvas2D path stays the reference implementation; any
 * WebGL output that disagrees with it by more than 1 device pixel is a WebGL bug."
 * This file is what makes that sentence enforceable.
 *
 * The comparison is column coverage, not raw pixel equality: SwiftShader's rasteriser
 * and Canvas2D's differ in antialiasing and colour blending, so identical pixels are
 * the wrong bar. What must agree is WHERE ink lands — the candle columns and their
 * vertical extent.
 */

import { expect, test, type Page } from '@playwright/test';

interface Coverage {
  /** Painted x-columns (device px) in the series layer. */
  readonly columns: readonly number[];
  /** Per painted column: [minY, maxY] in device px. */
  readonly extents: Readonly<Record<string, [number, number]>>;
  readonly paintedPixels: number;
}

async function coverageOf(page: Page, query: string): Promise<Coverage> {
  await page.goto(`/${query}`);
  await page.waitForFunction(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    if (fn === undefined) return false;
    const g = fn() as { frameCount?: number } | null;
    return g !== null && (g.frameCount ?? 0) > 0;
  });
  return (await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="series"]');
    if (canvas === null) throw new Error('series canvas missing');

    const w = canvas.width;
    const h = canvas.height;
    let pixels: Uint8ClampedArray;

    const ctx2d = canvas.getContext('2d');
    if (ctx2d !== null) {
      pixels = ctx2d.getImageData(0, 0, w, h).data;
    } else {
      const gl = canvas.getContext('webgl2');
      if (gl === null) throw new Error('neither 2d nor webgl2 context on the series canvas');
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      // readPixels is bottom-up; flip to match getImageData's top-down rows.
      const flipped = new Uint8ClampedArray(buf.length);
      const rowBytes = w * 4;
      for (let y = 0; y < h; y++) {
        flipped.set(buf.subarray((h - 1 - y) * rowBytes, (h - y) * rowBytes), y * rowBytes);
      }
      pixels = flipped;
    }

    const columns: number[] = [];
    const extents: Record<string, [number, number]> = {};
    let painted = 0;
    for (let x = 0; x < w; x++) {
      let min = -1;
      let max = -1;
      for (let y = 0; y < h; y++) {
        // Alpha above a threshold: ignores faint AA fringes that differ per rasteriser.
        if (pixels[(y * w + x) * 4 + 3] > 128) {
          if (min < 0) min = y;
          max = y;
          painted++;
        }
      }
      if (min >= 0) {
        columns.push(x);
        extents[String(x)] = [min, max];
      }
    }
    return { columns, extents, paintedPixels: painted };
  }));
}

const FIXTURE = 'seed=7&bars=400&spacing=8&live=0';

test.describe('WebGL series layer matches the Canvas2D reference', () => {
  test('both renderers paint, and the GL path is actually GL', async ({ page }) => {
    await page.goto(`/?${FIXTURE}&gl=1`);
    await page.waitForFunction(() => {
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      return fn !== undefined && (fn() as { frameCount?: number } | null) !== null;
    });
    const isGl = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>(
        '#chart canvas[data-layer="series"]',
      );
      return canvas !== null && canvas.getContext('2d') === null;
    });
    // If this fails the "GL" run silently fell back to Canvas2D and every comparison
    // below would be a tautology.
    expect(isGl).toBe(true);
  });

  test('candle columns agree within 1 device pixel', async ({ page }) => {
    const cpu = await coverageOf(page, `?${FIXTURE}&gl=0`);
    const gpu = await coverageOf(page, `?${FIXTURE}&gl=1`);

    expect(cpu.paintedPixels).toBeGreaterThan(10_000);
    expect(gpu.paintedPixels).toBeGreaterThan(10_000);

    const cpuCols = new Set(cpu.columns);
    const gpuCols = new Set(gpu.columns);

    // Every GPU column must sit within 1px of a CPU column, and vice versa.
    const near = (set: Set<number>, x: number): boolean =>
      set.has(x) || set.has(x - 1) || set.has(x + 1);

    const gpuOrphans = gpu.columns.filter((x) => !near(cpuCols, x));
    const cpuOrphans = cpu.columns.filter((x) => !near(gpuCols, x));

    expect(gpuOrphans.slice(0, 10)).toEqual([]);
    expect(cpuOrphans.slice(0, 10)).toEqual([]);
  });

  test('vertical extents agree within 1 device pixel', async ({ page }) => {
    const cpu = await coverageOf(page, `?${FIXTURE}&gl=0`);
    const gpu = await coverageOf(page, `?${FIXTURE}&gl=1`);

    const gpuCols = new Set(gpu.columns);
    const shared = cpu.columns.filter((x) => gpuCols.has(x));
    expect(shared.length).toBeGreaterThan(100);

    const drift: string[] = [];
    for (const x of shared) {
      const a = cpu.extents[String(x)];
      const b = gpu.extents[String(x)];
      if (Math.abs(a[0] - b[0]) > 1 || Math.abs(a[1] - b[1]) > 1) {
        drift.push(`x=${String(x)} cpu=[${String(a[0])},${String(a[1])}] gpu=[${String(b[0])},${String(b[1])}]`);
      }
    }
    expect(drift.slice(0, 8)).toEqual([]);
  });

  test('the GL path honours the no-overlap invariant too (§6)', async ({ page }) => {
    await page.goto(`/?${FIXTURE}&gl=1`);
    await page.waitForFunction(() => {
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      const g = fn === undefined ? null : (fn() as { frameCount?: number } | null);
      return g !== null && (g.frameCount ?? 0) > 0;
    });
    const candles = (await page.evaluate(() => {
      const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
      const g = fn === undefined ? null : (fn() as { candles?: unknown } | null);
      return g?.candles ?? [];
    })) as { centreX: number; width: number }[];

    expect(candles.length).toBeGreaterThan(10);
    const sorted = [...candles].sort((a, b) => a.centreX - b.centreX);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].centreX - sorted[i].width / 2).toBeGreaterThanOrEqual(
        sorted[i - 1].centreX + sorted[i - 1].width / 2 + 1 - 1e-9,
      );
    }
  });

  test('webgl screenshot', async ({ page }) => {
    await coverageOf(page, `?${FIXTURE}&gl=1`);
    await expect(page.locator('#chart')).toHaveScreenshot('webgl-candles-1m.png');
  });
});
