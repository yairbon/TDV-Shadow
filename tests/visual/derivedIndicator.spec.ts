/**
 * An indicator computed from another indicator, end to end.
 *
 * Three things have to hold in the running app that unit tests cannot see: the values the
 * control API reports are the ones actually drawn, a change to the PARENT recomputes the
 * child, and the pairing survives a reload. The first was broken when this was written —
 * `readIndicator` recomputed from id and params alone, so it reported a curve with a
 * different warm-up and different values from the one on the chart.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

async function open(page: Page): Promise<void> {
  await page.goto('/?seed=7&bars=200&live=0');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

interface Api {
  addIndicator: (id: string, params?: Record<string, unknown>) => { handleId: string };
  readIndicator: (h: string) => readonly { values: Record<string, number> }[];
  getState: () => { indicators: readonly { handleId: string; id: string }[] };
}

/** Adds an RSI and an SMA that reads it; returns both handles. */
async function stack(page: Page): Promise<{ rsi: string; sma: string }> {
  return page.evaluate(() => {
    const tdv = (window as unknown as { __tdv: Api }).__tdv;
    const rsi = tdv.addIndicator('rsi', { period: 14 });
    const sma = tdv.addIndicator('sma', { period: 9, source: `${rsi.handleId}:rsi` });
    return { rsi: rsi.handleId, sma: sma.handleId };
  });
}

/** Warm-up (leading non-finite count) and last value of one plot. */
const readPlot = (page: Page, handleId: string, key: string): Promise<{ warmup: number; last: number }> =>
  page.evaluate(
    ([h, k]) => {
      const rows = (window as unknown as { __tdv: Api }).__tdv.readIndicator(h);
      const warmup = rows.findIndex((row) => Number.isFinite(row.values[k]));
      return { warmup, last: rows[rows.length - 1]?.values[k] ?? Number.NaN };
    },
    [handleId, key],
  );

test.describe('an indicator computed from another', () => {
  test('reports the derived curve, not the same indicator over price', async ({ page }) => {
    await open(page);
    const { rsi, sma } = await stack(page);
    await page.waitForTimeout(500);

    const derived = await readPlot(page, sma, 'sma');
    const source = await readPlot(page, rsi, 'rsi');

    // 14-period RSI forms at 14; a 9-period mean of it needs nine more.
    expect(source.warmup).toBe(14);
    expect(derived.warmup).toBe(22);
    // And the value is a mean of RSI readings, so it lives in the RSI's 0..100, nowhere
    // near the ~98 the price series trades at.
    expect(derived.last).toBeGreaterThan(0);
    expect(derived.last).toBeLessThan(100);
  });

  test('agrees with the mean of the source’s own last nine readings', async ({ page }) => {
    // The arithmetic, checked against the OTHER handle's reported values — so a derived
    // series computed from the wrong parent, or from price, cannot pass.
    await open(page);
    const { rsi, sma } = await stack(page);
    await page.waitForTimeout(500);

    const agreement = await page.evaluate(
      ([r, s]) => {
        const tdv = (window as unknown as { __tdv: Api }).__tdv;
        const rsiRows = tdv.readIndicator(r);
        const smaRows = tdv.readIndicator(s);
        const tail = rsiRows.slice(-9).map((row) => row.values['rsi']);
        const mean = tail.reduce((a, b) => a + b, 0) / 9;
        return { mean, last: smaRows[smaRows.length - 1]?.values['sma'] ?? Number.NaN };
      },
      [rsi, sma],
    );
    expect(agreement.last).toBeCloseTo(agreement.mean, 6);
  });

  test('recomputes when the PARENT changes, not only when it does', async ({ page }) => {
    // The child's own params are untouched by an edit to its parent, so a cache keyed on
    // them alone keeps serving a curve derived from a series that no longer exists.
    await open(page);
    const { rsi, sma } = await stack(page);
    await page.waitForTimeout(500);
    const before = await readPlot(page, sma, 'sma');

    await page.evaluate((h) => {
      (
        window as unknown as {
          __chart: { updateIndicator: (h: string, p: { params: { period: number } }) => void };
        }
      ).__chart.updateIndicator(h, { params: { period: 4 } });
    }, rsi);
    await page.waitForTimeout(500);
    const after = await readPlot(page, sma, 'sma');

    // A 4-period RSI forms at 4, so the pair now forms at 12 rather than 22.
    expect(after.warmup).toBe(12);
    expect(after.last).not.toBeCloseTo(before.last, 6);
  });

  test('draws in its source’s pane rather than off the price plot', async ({ page }) => {
    // An SMA of an RSI is in the RSI's units. Left on the price plot it sits far outside
    // the visible range and is clipped away — correct values, nothing on screen.
    await open(page);

    // The RSI alone first, so the pane's ink can be compared with and without the SMA.
    const rsi = await page.evaluate(
      () =>
        (window as unknown as { __tdv: Api }).__tdv.addIndicator('rsi', { period: 14 }).handleId,
    );
    await page.waitForTimeout(600);

    const paneInk = (): Promise<number> =>
      page.evaluate(() => {
        const chart = (window as unknown as {
          __chart: {
            layout: () => {
              panes: readonly { top: number; left: number; width: number; height: number }[];
            };
          };
        }).__chart;
        const pane = chart.layout().panes[0];
        const canvas = document.querySelector<HTMLCanvasElement>(
          '#chart canvas[data-layer="overlay"]',
        );
        const ctx = canvas?.getContext('2d') ?? null;
        if (canvas === null || ctx === null) return -1;
        const dpr = canvas.width / canvas.getBoundingClientRect().width;
        const data = ctx.getImageData(
          Math.round(pane.left * dpr),
          Math.round(pane.top * dpr),
          Math.round(pane.width * dpr),
          Math.round(pane.height * dpr),
        ).data;

        // Contrast against the dominant colour, NOT alpha: a pane paints an opaque
        // background of its own, so every pixel in it scores 255 and an alpha count comes
        // out identical whether one line is drawn in there or three.
        const tally = new Map<number, number>();
        for (let o = 0; o < data.length; o += 4) {
          const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2];
          tally.set(key, (tally.get(key) ?? 0) + 1);
        }
        let background = 0;
        let best = -1;
        for (const [key, n] of tally) if (n > best) [background, best] = [key, n];
        const br = (background >> 16) & 0xff;
        const bg = (background >> 8) & 0xff;
        const bb = background & 0xff;

        let ink = 0;
        for (let o = 0; o < data.length; o += 4) {
          const distance =
            Math.abs(data[o] - br) + Math.abs(data[o + 1] - bg) + Math.abs(data[o + 2] - bb);
          if (distance > 60) ink++;
        }
        return ink;
      });

    const before = await paneInk();
    expect(before).toBeGreaterThan(0);

    const sma = await page.evaluate(
      (h) =>
        (window as unknown as { __tdv: Api }).__tdv.addIndicator('sma', {
          period: 9,
          source: `${h}:rsi`,
        }).handleId,
      rsi,
    );
    await page.waitForTimeout(600);

    // It reports the RSI as its home — the fact, stated rather than inferred from pixels.
    const host = await page.evaluate(
      (h) =>
        (window as unknown as { __chart: { indicatorPaneHost: (h: string) => string | null } })
          .__chart.indicatorPaneHost(h),
      sma,
    );
    expect(host).toBe(rsi);

    // Still one pane: it joined the RSI's rather than asking for its own.
    const panes = await page.evaluate(
      () =>
        (window as unknown as { __chart: { layout: () => { panes: readonly unknown[] } } }).__chart
          .layout().panes.length,
    );
    expect(panes).toBe(1);

    // And a second line really is painted in there. Ink measured against the same pane
    // before the SMA existed, so a line drawn somewhere else cannot satisfy this.
    expect(await paneInk()).toBeGreaterThan(before * 1.4);
  });

  test('survives a reload with the pairing intact', async ({ page }) => {
    await open(page);
    const { sma } = await stack(page);
    await page.waitForTimeout(500);
    const before = await readPlot(page, sma, 'sma');

    await page.waitForTimeout(2400); // let the autosave interval run
    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(900);

    const restored = await page.evaluate(() => {
      const state = (window as unknown as { __tdv: Api }).__tdv.getState();
      return state.indicators.map((i) => i.id);
    });
    expect(restored).toEqual(['rsi', 'sma']);

    // Handles are reassigned on restore, so read the second one back by position.
    const after = await page.evaluate(() => {
      const tdv = (window as unknown as { __tdv: Api }).__tdv;
      const handle = tdv.getState().indicators[1];
      const rows = tdv.readIndicator(handle.handleId);
      const warmup = rows.findIndex((row) => Number.isFinite(row.values['sma']));
      return { warmup, last: rows[rows.length - 1]?.values['sma'] ?? Number.NaN };
    });
    expect(after.warmup).toBe(before.warmup);
    expect(after.last).toBeCloseTo(before.last, 6);
  });

  test('falls back to price rather than drawing nothing when the source is gone', async ({
    page,
  }) => {
    // Removing the parent leaves a dangling reference. Silently drawing nothing would
    // look like the indicator is broken; falling back to price is at least legible.
    await open(page);
    const { rsi, sma } = await stack(page);
    await page.waitForTimeout(500);

    await page.evaluate((h) => {
      (window as unknown as { __tdv: { removeIndicator: (h: string) => void } }).__tdv.removeIndicator(h);
    }, rsi);
    await page.waitForTimeout(500);

    const after = await readPlot(page, sma, 'sma');
    expect(Number.isFinite(after.last)).toBe(true);
    // A 9-period SMA of PRICE: it warms up at 8 and reads near the traded price.
    expect(after.warmup).toBe(8);
    expect(after.last).toBeGreaterThan(50);
  });

  test('offers only earlier indicators as sources, so a cycle cannot be built', async ({
    page,
  }) => {
    await open(page);
    const { rsi, sma } = await stack(page);
    await page.waitForTimeout(500);

    // Open the settings for the FIRST indicator; nothing precedes it, so its Source
    // picker holds price fields only.
    await page.evaluate(
      (h) => {
        const row = document.querySelector<HTMLElement>(`#legend [data-handle="${h}"]`);
        row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      },
      rsi,
    );
    await page.waitForTimeout(300);
    const firstOptions = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLOptionElement>('#indicator-settings [data-param="source"] option')].map(
        (o) => o.value,
      ),
    );
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(firstOptions.some((v) => v.includes(':'))).toBe(false);

    // The second one may read the first.
    await page.evaluate(
      (h) => {
        const row = document.querySelector<HTMLElement>(`#legend [data-handle="${h}"]`);
        row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      },
      sma,
    );
    await page.waitForTimeout(300);
    const secondOptions = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLOptionElement>('#indicator-settings [data-param="source"] option')].map(
        (o) => o.value,
      ),
    );
    expect(secondOptions).toContain(`${rsi}:rsi`);
  });
});
