/**
 * Named layouts.
 *
 * The autosave is where you are right now; a named layout is a snapshot you chose to
 * keep. The interesting part is the seam between the two — saving must not disturb the
 * autosave, and opening must not be quietly undone by it.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';
import { selectControl } from './controls.js';

interface State {
  readonly symbol: string;
  readonly indicators: number;
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(400);
}

const state = (page: Page): Promise<State> =>
  page.evaluate(() => {
    const api = (window as {
      __tdv?: { getState: () => { symbol: string; indicators: readonly unknown[] } };
    }).__tdv;
    const s = api?.getState();
    return { symbol: s?.symbol ?? '', indicators: s?.indicators.length ?? -1 };
  });

async function saveAs(page: Page, name: string): Promise<void> {
  await selectControl(page, '#saved-layouts', 'save');
  await page.waitForSelector('#tp-input', { state: 'visible' });
  await page.fill('#tp-input', name);
  await page.click('.tp-confirm');
  await page.waitForTimeout(400);
}

async function openSaved(page: Page, name: string): Promise<void> {
  const value = await page.$$eval(
    '#saved-layouts option',
    (nodes, wanted) =>
      (nodes as HTMLOptionElement[]).find((o) => o.textContent === wanted)?.value ?? '',
    name,
  );
  expect(value).not.toBe('');
  await selectControl(page, '#saved-layouts', value);
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(1200);
}

test.describe('named layouts', () => {
  test('saves the current chart under a name', async ({ page }) => {
    await open(page);
    await saveAs(page, 'My study');
    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent),
    );
    expect(labels).toContain('My study');
  });

  test('reopening restores the chart the layout was saved from', async ({ page }) => {
    await open(page);
    await page.selectOption('#symbol-pick', 'NVDA');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      (window as { __tdv?: { addIndicator: (i: string) => unknown } }).__tdv?.addIndicator('rsi');
    });
    await page.waitForTimeout(300);
    await saveAs(page, 'NVDA study');

    // Move somewhere else entirely.
    await page.selectOption('#symbol-pick', 'AAPL');
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const api = (window as {
        __tdv?: {
          getState: () => { indicators: readonly { handleId: string }[] };
          removeIndicator: (h: string) => boolean;
        };
      }).__tdv;
      for (const i of api?.getState().indicators ?? []) api?.removeIndicator(i.handleId);
    });
    await page.waitForTimeout(500);
    expect(await state(page)).toMatchObject({ symbol: 'AAPL', indicators: 0 });

    await openSaved(page, 'NVDA study');
    // The autosave runs on beforeunload too, and opening a layout reloads — so this fails
    // if the departing chart is allowed to overwrite the layout on the way out.
    expect(await state(page)).toMatchObject({ symbol: 'NVDA', indicators: 1 });
  });

  test('saving does not switch the live chart to the saved copy', async ({ page }) => {
    // "Save" must not quietly become "switch to": the next edit has to keep going to the
    // session you are actually in.
    await open(page);
    await page.selectOption('#symbol-pick', 'NVDA');
    await page.waitForTimeout(600);
    await saveAs(page, 'Snapshot');

    await page.selectOption('#symbol-pick', 'TSLA');
    await page.waitForTimeout(600);
    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(800);
    // The autosave kept tracking, so a plain reload lands on TSLA, not on the snapshot.
    expect((await state(page)).symbol).toBe('TSLA');
  });

  test('saving the same name twice replaces rather than duplicating', async ({ page }) => {
    await open(page);
    await saveAs(page, 'Same');
    await saveAs(page, 'Same');
    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent).filter((t) => t === 'Same'),
    );
    expect(labels).toHaveLength(1);
  });

  test('cancelling the prompt saves nothing', async ({ page }) => {
    await open(page);
    await selectControl(page, '#saved-layouts', 'save');
    await page.waitForSelector('#tp-input', { state: 'visible' });
    await page.fill('#tp-input', 'Discarded');
    await page.click('.tp-cancel');
    await page.waitForTimeout(300);
    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent),
    );
    expect(labels).not.toContain('Discarded');
  });

  test('Escape on the prompt saves nothing and does not hang', async ({ page }) => {
    // `close` fires without a click for Escape, so a promise that only settles on a
    // button press would never resolve and the app would sit waiting forever.
    await open(page);
    await selectControl(page, '#saved-layouts', 'save');
    await page.waitForSelector('#tp-input', { state: 'visible' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    expect(await page.locator('#text-prompt[open]').count()).toBe(0);
    // And the app is still responsive afterwards.
    await saveAs(page, 'After escape');
    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent),
    );
    expect(labels).toContain('After escape');
  });

  test('deleting removes it from the list', async ({ page }) => {
    await open(page);
    await saveAs(page, 'Doomed');
    await selectControl(page, '#saved-layouts', 'manage');
    await page.waitForSelector('#tp-input', { state: 'visible' });
    await page.fill('#tp-input', 'Doomed');
    await page.click('.tp-confirm');
    await page.waitForTimeout(400);

    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent),
    );
    expect(labels).not.toContain('Doomed');
  });

  test('layouts survive a reload', async ({ page }) => {
    await open(page);
    await saveAs(page, 'Persistent');
    await page.reload();
    await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
    await page.waitForTimeout(600);
    const labels = await page.$$eval('#saved-layouts option', (n) =>
      n.map((o) => o.textContent),
    );
    expect(labels).toContain('Persistent');
  });
});
