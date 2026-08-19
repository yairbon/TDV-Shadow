/**
 * The previous-session close line.
 *
 * Ink-on-the-overlay-layer is the weakest thing these tests could assert, so they do not
 * stop there: the middle test pins the line to the exact row `projectAnchor` puts the
 * previous close on. A line drawn from the wrong bar, or one baked at a fixed offset,
 * still produces ink — it just produces it somewhere else.
 *
 * The suite runs against `vite preview`, which has no dev proxy and therefore no Yahoo,
 * so these use the bundled daily AAPL series. That is deliberate: it is the branch of
 * `previousSessionClose` that needs no session bucketing, and it is deterministic. The
 * intraday branch is covered by tests/unit/data/previousClose.spec.ts.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

interface Tdv {
  readOhlcv: () => readonly { time: number; close: number }[];
  projectAnchor: (a: { barIndex: number; price: number }) => { x: number; y: number };
}

async function open(page: Page): Promise<void> {
  await page.goto('/?sym=AAPL');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.waitForTimeout(300);
}

/** Opaque pixels on the overlay layer. Overlays are the only thing drawn there. */
const overlayInk = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector('#chart canvas[data-layer="overlay"]');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return -1;
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) lit += 1;
    return lit;
  });

/**
 * Opaque pixels on one DEVICE row of the overlay layer, counting the PLOT only.
 *
 * The right fifth is skipped because the price gutter is there, and the line's tag is a
 * filled block about sixteen CSS pixels tall. Counting the whole row therefore reports
 * healthy ink for any row within eight pixels of the line — which is most of the rows a
 * wrong answer would land on. A first draft did count the whole row, and a mutation that
 * drew the line off the close of the wrong bar entirely sailed through it.
 */
const plotRowInk = (page: Page, cssY: number): Promise<number> =>
  page.evaluate((y) => {
    const canvas = document.querySelector('#chart canvas[data-layer="overlay"]');
    if (!(canvas instanceof HTMLCanvasElement)) return -1;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return -1;
    const dpr = canvas.width / canvas.getBoundingClientRect().width;
    const width = Math.floor(canvas.width * 0.8);
    const { data } = ctx.getImageData(0, Math.round(y * dpr), width, 1);
    let lit = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 40) lit += 1;
    return lit;
  }, cssY);

/** The plot width in device pixels, i.e. what `plotRowInk` could count at most. */
const plotWidth = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const canvas = document.querySelector('#chart canvas[data-layer="overlay"]');
    return canvas instanceof HTMLCanvasElement ? Math.floor(canvas.width * 0.8) : 0;
  });

async function setPreviousClose(page: Page, on: boolean): Promise<void> {
  await page.click('#chart-settings');
  await page.waitForSelector('#chart-settings-sheet[open]');
  const box = page.locator('#chart-prev-close');
  if (on) await box.check();
  else await box.uncheck();
  await page.waitForTimeout(250);
  // OK, not Escape. Escape is cancel, and cancel re-applies the settings the dialog was
  // opened with — so measuring after it measures the state before the click. The first
  // draft of this helper did exactly that and reported "the toggle does nothing" for a
  // toggle that works; the last test in this file now pins that revert deliberately.
  await page.click('#chart-ok');
  await page.waitForTimeout(250);
}

test.describe('previous close line', () => {
  test('is drawn by default and disappears when switched off', async ({ page }) => {
    await open(page);
    const withLine = await overlayInk(page);
    expect(withLine).toBeGreaterThan(0);

    await setPreviousClose(page, false);
    const without = await overlayInk(page);
    // Strictly fewer: other overlays (the last-price line) stay, so this is not "empty",
    // it is "one line's worth less".
    expect(without).toBeLessThan(withLine);

    await setPreviousClose(page, true);
    expect(await overlayInk(page)).toBe(withLine);
  });

  test('sits on the row the previous session close projects to', async ({ page }) => {
    await open(page);
    const y = await page.evaluate(() => {
      const api = (window as unknown as { __tdv: Tdv }).__tdv;
      const rows = api.readOhlcv();
      const previous = rows[rows.length - 2];
      return api.projectAnchor({ barIndex: rows.length - 1, price: previous.close }).y;
    });

    const onLine = await plotRowInk(page, y);
    // Four CSS px away is off the line but still inside its gutter tag, so this is the
    // assertion the tag was hiding: the LINE is on this row, not merely near it.
    expect(await plotRowInk(page, y + 4)).toBe(0);
    // Half the plot width, because the pattern is [3, 3] — see the dash test below.
    expect(onLine).toBeGreaterThan((await plotWidth(page)) * 0.4);
  });

  test('is dashed, not solid', async ({ page }) => {
    await open(page);
    const y = await page.evaluate(() => {
      const api = (window as unknown as { __tdv: Tdv }).__tdv;
      const rows = api.readOhlcv();
      return api.projectAnchor({ barIndex: rows.length - 1, price: rows[rows.length - 2].close })
        .y;
    });
    const width = await plotWidth(page);
    const lit = await plotRowInk(page, y);
    // A solid rule lights the whole plot width. The pattern is [3, 3] in CSS px at DPR 2,
    // so the line covers a little over half of it once the anti-aliased dash ends are
    // counted. Both bounds matter: the upper one fails a solid line, the lower one fails
    // a line so sparse it is not legible.
    expect(lit).toBeLessThan(width * 0.75);
    expect(lit).toBeGreaterThan(width * 0.4);
  });

  test('Escape cancels the change instead of applying it', async ({ page }) => {
    await open(page);
    const before = await overlayInk(page);

    await page.click('#chart-settings');
    await page.waitForSelector('#chart-settings-sheet[open]');
    await page.locator('#chart-prev-close').uncheck();
    await page.waitForTimeout(250);
    // Asserted here, not just at the end: without it this test passes for a build that
    // ignores the setting entirely, since "unchanged after cancel" is trivially true when
    // nothing ever changes. A mutation proved that, so the preview is pinned too.
    expect(await overlayInk(page)).toBeLessThan(before);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // The dialog previews live, so the line does vanish while it is open — and comes back
    // when the dialog is dismissed without confirming. A settings sheet that kept a change
    // the reader backed out of is worse than one that never previewed at all.
    expect(await overlayInk(page)).toBe(before);
  });
});
