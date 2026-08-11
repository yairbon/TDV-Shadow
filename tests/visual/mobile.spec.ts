/**
 * Phone viewport and touch gestures.
 *
 * A phone has no wheel and no hover, so the desktop suite proves nothing about it. These
 * tests run at 390x844 with dpr 3 and drive real PointerEvents of `pointerType: 'touch'`
 * against the crosshair canvas — the element a finger actually lands on. Dispatching at
 * the container instead silently proves nothing: events bubble up, not down, so the
 * listeners never see them and every gesture appears to "work" by doing nothing.
 */

import { expect, test, type Page } from '@playwright/test';

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});

const FIXTURE = '?seed=7&bars=400&spacing=8&live=0';

interface Snapshot {
  readonly dpr: number;
  readonly css: { width: number; height: number };
  readonly plotHeight: number;
  readonly spacing: number;
  readonly scroll: number;
  readonly candles: number;
}

async function open(page: Page): Promise<Snapshot> {
  await page.goto(`/${FIXTURE}`);
  await page.waitForFunction(() => {
    const fn = (window as { __chartGeometry?: () => unknown }).__chartGeometry;
    const g = fn === undefined ? null : (fn() as { frameCount?: number } | null);
    return g !== null && (g.frameCount ?? 0) > 0;
  });
  return read(page);
}

function read(page: Page): Promise<Snapshot> {
  return page.evaluate(() => {
    const win = window as unknown as {
      __chartGeometry: () => {
        dpr: number;
        cssSize: { width: number; height: number };
        plot: { height: number };
        candles: unknown[];
      };
      __chart: { view: { get: () => { barSpacing: number; scrollPosition: number } } };
    };
    const g = win.__chartGeometry();
    const view = win.__chart.view.get();
    return {
      dpr: g.dpr,
      css: g.cssSize,
      plotHeight: g.plot.height,
      spacing: view.barSpacing,
      scroll: view.scrollPosition,
      candles: g.candles.length,
    };
  });
}

/** Dispatches touch pointer events on the layer that actually receives them. */
async function touch(
  page: Page,
  steps: { type: string; points: [number, number, number][] }[],
): Promise<void> {
  await page.evaluate((sequence) => {
    const el = document.querySelector('#chart canvas[data-layer="crosshair"]');
    if (el === null) throw new Error('crosshair canvas missing');
    for (const step of sequence) {
      for (const [id, x, y] of step.points) {
        el.dispatchEvent(
          new PointerEvent(step.type, {
            pointerId: id,
            pointerType: 'touch',
            clientX: x,
            clientY: y,
            bubbles: true,
            isPrimary: id === 1,
          }),
        );
      }
    }
  }, steps);
  await page.waitForTimeout(150);
}

test.describe('phone layout', () => {
  test('fits the viewport with no page scroll in either axis', async ({ page }) => {
    await open(page);
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      y: document.documentElement.scrollHeight - document.documentElement.clientHeight,
    }));
    expect(overflow.x).toBeLessThanOrEqual(0);
    expect(overflow.y).toBeLessThanOrEqual(0);
  });

  test('leaves the plot a usable height beside the toolbar', async ({ page }) => {
    const snapshot = await open(page);
    expect(snapshot.css.width).toBe(390);
    // The toolbar must not eat the chart: over half the viewport stays plot.
    expect(snapshot.plotHeight).toBeGreaterThan(300);
    expect(snapshot.candles).toBeGreaterThan(10);
  });

  test('honours devicePixelRatio 3 in the backing store', async ({ page }) => {
    const snapshot = await open(page);
    expect(snapshot.dpr).toBe(3);
    const backing = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('#chart canvas[data-layer="grid"]');
      return c === null ? null : { w: c.width, h: c.height };
    });
    expect(backing?.w).toBe(Math.round(snapshot.css.width * 3));
    expect(backing?.h).toBe(Math.round(snapshot.css.height * 3));
  });

  test('declines the browser default gestures on the canvas', async ({ page }) => {
    await open(page);
    // Without touch-action: none the browser keeps the pan/pinch for itself and the
    // chart never receives the gesture at all.
    const touchAction = await page.evaluate(() => {
      const c = document.querySelector('#chart canvas[data-layer="crosshair"]');
      return c === null ? '' : getComputedStyle(c).touchAction;
    });
    expect(touchAction).toBe('none');
  });
});

test.describe('touch gestures', () => {
  test('pinch outward zooms in', async ({ page }) => {
    const before = await open(page);
    const moves = Array.from({ length: 8 }, (_, i) => ({
      type: 'pointermove',
      points: [
        [1, 150 - (i + 1) * 8, 400],
        [2, 250 + (i + 1) * 8, 400],
      ] as [number, number, number][],
    }));
    await touch(page, [
      { type: 'pointerdown', points: [[1, 150, 400], [2, 250, 400]] },
      ...moves,
      { type: 'pointerup', points: [[1, 86, 400], [2, 314, 400]] },
    ]);
    const after = await read(page);
    expect(after.spacing).toBeGreaterThan(before.spacing);
  });

  test('pinch inward zooms out', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      (window as unknown as { __chart: { view: { setBarSpacing: (n: number) => void } } }).__chart.view.setBarSpacing(40);
    });
    const before = await read(page);
    const moves = Array.from({ length: 8 }, (_, i) => ({
      type: 'pointermove',
      points: [
        [1, 80 + (i + 1) * 8, 400],
        [2, 320 - (i + 1) * 8, 400],
      ] as [number, number, number][],
    }));
    await touch(page, [
      { type: 'pointerdown', points: [[1, 80, 400], [2, 320, 400]] },
      ...moves,
      { type: 'pointerup', points: [[1, 144, 400], [2, 256, 400]] },
    ]);
    const after = await read(page);
    expect(after.spacing).toBeLessThan(before.spacing);
  });

  test('one-finger drag pans', async ({ page }) => {
    const before = await open(page);
    const moves = [300, 275, 250, 225, 200, 175, 150].map((x) => ({
      type: 'pointermove',
      points: [[5, x, 400]] as [number, number, number][],
    }));
    await touch(page, [
      { type: 'pointerdown', points: [[5, 300, 400]] },
      ...moves,
      { type: 'pointerup', points: [[5, 150, 400]] },
    ]);
    const after = await read(page);
    expect(after.scroll).not.toBeCloseTo(before.scroll, 3);
  });

  test('lifting one finger of a pinch does not jump the chart', async ({ page }) => {
    await open(page);
    await touch(page, [
      { type: 'pointerdown', points: [[1, 120, 400], [2, 280, 400]] },
      { type: 'pointermove', points: [[1, 100, 400], [2, 300, 400]] },
      { type: 'pointerup', points: [[2, 300, 400]] },
    ]);
    const afterLift = await read(page);
    // The remaining finger sits far from where a pan would have started; resuming the
    // drag here would yank scrollPosition by that whole distance.
    await touch(page, [{ type: 'pointermove', points: [[1, 101, 400]] }]);
    const afterMove = await read(page);
    expect(Math.abs(afterMove.scroll - afterLift.scroll)).toBeLessThan(1);
  });

  test('phone screenshot', async ({ page }) => {
    await open(page);
    await expect(page).toHaveScreenshot('phone.png', { fullPage: true });
  });
});
