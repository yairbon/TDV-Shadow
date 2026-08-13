/**
 * The rail, once it became groups.
 *
 * A flat rail listed fifteen tools against a catalogue of thirty, so half of what this app
 * can draw had no way to reach it — and the eight added in Tier 3 would have pushed a flat
 * rail past the height of an 800px window, where the overflow is a scrollbar nobody looks
 * for. These tests hold the two properties that fix is worth anything for: every kind is
 * reachable, and picking one from a flyout arms that kind and not its slot's default.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './harness.js';

async function open(page: Page): Promise<void> {
  await page.goto('/?seed=7&bars=200&live=0');
  await page.waitForFunction(() => (window as { __tdv?: unknown }).__tdv !== undefined);
  await page.waitForTimeout(300);
}

/** Every tool id the rail offers, across all its groups. */
const railTools = (page: Page): Promise<string[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('#tool-rail [data-menu-tool]')]
      .map((node) => node.dataset['menuTool'] ?? '')
      .concat(
        [...document.querySelectorAll<HTMLElement>('#tool-rail .rail-slot > button')].map(
          (node) => node.dataset['tool'] ?? '',
        ),
      ),
  );

const armed = (page: Page): Promise<string> =>
  page.evaluate(
    () =>
      (window as { __tdv?: { getState: () => { activeTool: string } } }).__tdv?.getState()
        .activeTool ?? '?',
  );

test.describe('the grouped tool rail', () => {
  test('offers every drawing kind the app implements', async ({ page }) => {
    await open(page);
    const offered = new Set(await railTools(page));
    const kinds = await page.evaluate(
      () => [...((window as { __tdv?: { toolKinds: () => readonly string[] } }).__tdv?.toolKinds() ?? [])],
    );
    expect(kinds.length).toBeGreaterThan(20);
    const missing = kinds.filter((kind) => !offered.has(kind));
    expect(missing, 'drawing kinds with no way to reach them').toEqual([]);
  });

  test('keeps the rail short enough to fit an 800px window', async ({ page }) => {
    // The reason for grouping. A rail taller than its box scrolls, and a scrolling rail
    // hides tools exactly as thoroughly as not listing them.
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const fits = await page.evaluate(() => {
      const rail = document.querySelector('#tool-rail');
      if (rail === null) return null;
      return { scroll: rail.scrollHeight, client: rail.clientHeight };
    });
    expect(fits).not.toBeNull();
    expect(fits?.scroll ?? 1).toBeLessThanOrEqual((fits?.client ?? 0) + 1);
  });

  test('a slot arms what it shows, in one click', async ({ page }) => {
    await open(page);
    await page.click('#tool-rail .rail-slot[data-group="lines"] > button');
    expect(await armed(page)).toBe('trendline');
  });

  test('picking from a flyout arms that tool, not the slot’s default', async ({ page }) => {
    await open(page);
    const slot = '#tool-rail .rail-slot[data-group="lines"]';
    await page.click(`${slot} .rail-more`);
    await page.waitForTimeout(120);
    await page.click(`${slot} [data-menu-tool="polyline"]`);
    expect(await armed(page)).toBe('polyline');
    // The menu closes behind it rather than sitting over the plot.
    expect(await page.locator(`${slot} .rail-menu`).isHidden()).toBe(true);
  });

  test('the slot then remembers it, so repeating is one click', async ({ page }) => {
    await open(page);
    const slot = '#tool-rail .rail-slot[data-group="fib"]';
    await page.click(`${slot} .rail-more`);
    await page.waitForTimeout(120);
    await page.click(`${slot} [data-menu-tool="fib-fan"]`);
    expect(await armed(page)).toBe('fib-fan');

    // Disarm, then click the slot itself: it repeats the fan, not the retracement.
    await page.keyboard.press('Escape');
    await page.click('#tool-rail .rail-slot[data-group="cursor"] > button');
    expect(await armed(page)).toBe('');
    await page.click(`${slot} > button`);
    expect(await armed(page)).toBe('fib-fan');
  });

  test('a keyboard shortcut arms a tool that lives inside a flyout', async ({ page }) => {
    // Alt+P is the polyline, the ninth entry of the lines group and never the slot's
    // default. The rail has to reflect what the keyboard armed, or the pressed
    // state describes a tool that is not the one placement will use.
    await open(page);
    await page.keyboard.press('Alt+p');
    expect(await armed(page)).toBe('polyline');
    const shown = await page.evaluate(
      () =>
        document.querySelector<HTMLElement>('#tool-rail .rail-slot[data-group="lines"] > button')
          ?.dataset['tool'] ?? '',
    );
    expect(shown).toBe('polyline');
    expect(
      await page
        .locator('#tool-rail .rail-slot[data-group="lines"] > button')
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  test('only one slot reads as pressed at a time', async ({ page }) => {
    await open(page);
    await page.click('#tool-rail .rail-slot[data-group="lines"] > button');
    await page.click('#tool-rail .rail-slot[data-group="shapes"] > button');
    const pressed = await page.evaluate(() =>
      [...document.querySelectorAll('#tool-rail .rail-slot > button')]
        .filter((node) => node.getAttribute('aria-pressed') === 'true')
        .map((node) => (node as HTMLElement).dataset['tool']),
    );
    expect(pressed).toEqual(['rectangle']);
  });

  test('Escape closes an open flyout without arming anything', async ({ page }) => {
    await open(page);
    const slot = '#tool-rail .rail-slot[data-group="gann"]';
    await page.click(`${slot} .rail-more`);
    await page.waitForTimeout(120);
    expect(await page.locator(`${slot} .rail-menu`).isHidden()).toBe(false);
    await page.keyboard.press('Escape');
    expect(await page.locator(`${slot} .rail-menu`).isHidden()).toBe(true);
    expect(await armed(page)).toBe('');
  });
});

test.describe('every pane indicator gets a pane', () => {
  /**
   * A pane indicator with no pane computes, prints its values in the legend, and draws
   * nowhere. That is exactly what happened to the six added in Tier 3: the layout counted
   * panes from a hand-kept list of ids that nobody updated, and a legend row pointing at
   * an absent plot is worse than the indicator not being offered at all.
   *
   * Walks the registry rather than naming ids, so the next one added is covered before it
   * is written.
   */
  test('adding one adds exactly one pane, for every id in the registry', async ({ page }) => {
    await open(page);
    const ids = await page.evaluate(() =>
      [...((window as { __tdv?: { indicatorIds: () => readonly string[] } }).__tdv?.indicatorIds() ?? [])],
    );
    expect(ids.length).toBeGreaterThan(15);

    for (const id of ids) {
      const before = await page.evaluate(
        () => (window as { __chart?: { layout: () => { panes: readonly unknown[] } } }).__chart?.layout().panes.length ?? -1,
      );
      const handle = await page.evaluate(
        (i) => (window as { __tdv?: { addIndicator: (i: string) => { handleId: string } } }).__tdv?.addIndicator(i),
        id,
      );
      await page.waitForTimeout(180);
      const after = await page.evaluate(
        () => (window as { __chart?: { layout: () => { panes: readonly unknown[] } } }).__chart?.layout().panes.length ?? -1,
      );
      const wantsPane = await page.evaluate(
        (i) => (window as { __tdv?: { indicatorPlacement: (i: string) => string } }).__tdv?.indicatorPlacement(i),
        id,
      );
      expect(after - before, `${id} (${String(wantsPane)}) changed the pane count by`).toBe(
        wantsPane === 'pane' ? 1 : 0,
      );

      // Put it back, so each id is measured against the same starting state.
      await page.evaluate(
        (h) => (window as { __tdv?: { removeIndicator: (h: string) => void } }).__tdv?.removeIndicator(h),
        handle?.handleId ?? '',
      );
      await page.waitForTimeout(120);
    }
  });
});

test.describe('a polyline finishes early', () => {
  const anchorsOf = (page: Page): Promise<number> =>
    page.evaluate(() => {
      const list =
        (window as { __tdv?: { listDrawings: () => readonly { anchors: readonly unknown[] }[] } })
          .__tdv?.listDrawings() ?? [];
      return list[list.length - 1]?.anchors.length ?? -1;
    });

  /** Clicks `n` points across the plot, spaced so no two land on one bar. */
  async function place(page: Page, n: number): Promise<void> {
    const box = await page.locator('#chart').boundingBox();
    if (box === null) throw new Error('no chart');
    for (let i = 0; i < n; i++) {
      await page.mouse.click(box.x + 120 + i * 70, box.y + 120 + (i % 2) * 90);
      await page.waitForTimeout(80);
    }
  }

  test('Enter commits the path at however many points are down', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+p');
    await place(page, 4);
    // Nothing committed yet: the tool collects up to eight on its own.
    expect(await anchorsOf(page)).toBe(-1);

    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    expect(await anchorsOf(page)).toBe(4);
  });

  test('Escape still throws the placement away rather than committing it', async ({ page }) => {
    // The two gestures have to stay distinct, or "cancel" silently becomes "save".
    await open(page);
    await page.keyboard.press('Alt+p');
    await place(page, 3);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    expect(await anchorsOf(page)).toBe(-1);
  });

  test('a two-anchor tool ignores Enter, since it has nothing to finish early', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Alt+t');
    await place(page, 1);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(200);
    // One anchor is not a trend line, and Enter must not invent the second.
    expect(await anchorsOf(page)).toBe(-1);

    await place(page, 1);
    await page.waitForTimeout(200);
    expect(await anchorsOf(page)).toBe(2);
  });
});

test.describe('the rail on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('opens a flyout on screen rather than off the right edge', async ({ page }) => {
    // The rail is a bottom bar at this width, so the desktop rule — open to the right of
    // the slot — puts every menu past the first few outside the viewport entirely.
    await open(page);
    const slot = '#tool-rail .rail-slot[data-group="notes"]';
    await page.click(`${slot} .rail-more`);
    await page.waitForTimeout(150);

    const menu = await page.locator(`${slot} .rail-menu`).boundingBox();
    const view = page.viewportSize();
    expect(menu).not.toBeNull();
    expect(view).not.toBeNull();
    if (menu === null || view === null) return;
    expect(menu.x).toBeGreaterThanOrEqual(0);
    expect(menu.x + menu.width).toBeLessThanOrEqual(view.width);
    expect(menu.y).toBeGreaterThanOrEqual(0);
    // Above the bar it belongs to, not under the fold.
    expect(menu.y + menu.height).toBeLessThanOrEqual(view.height);
  });

  test('still arms the tool that was picked', async ({ page }) => {
    await open(page);
    const slot = '#tool-rail .rail-slot[data-group="shapes"]';
    await page.click(`${slot} .rail-more`);
    await page.waitForTimeout(150);
    await page.click(`${slot} [data-menu-tool="ellipse"]`);
    expect(await armed(page)).toBe('ellipse');
  });
});
