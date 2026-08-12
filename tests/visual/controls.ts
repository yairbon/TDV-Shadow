/**
 * Reaching a toolbar control that the overflow panel may have swallowed.
 *
 * The top bar evicts its lower-priority controls into a panel behind a "•••" button when
 * the window is too narrow, and the suite runs at 1280px — narrow enough that the layout
 * picker, the scale and renderer toggles, the ticker box and Reset all live in there. A
 * plain `page.click('#layout-pick')` then times out against a hidden element.
 *
 * This does what a person does: if the control is in the panel, open the panel first.
 * Deliberately not "widen the viewport so everything fits" — that would change every
 * screenshot baseline and stop the suite exercising the width people actually use.
 */

import type { Page } from '@playwright/test';

/** Opens the overflow panel if `selector` is inside it. Safe to call unconditionally. */
export async function reveal(page: Page, selector: string): Promise<void> {
  const inPanel = await page.locator(`#toolbar-overflow ${selector}`).count();
  if (inPanel === 0) return;
  const expanded = await page.locator('#toolbar-more').getAttribute('aria-expanded');
  if (expanded !== 'true') await page.click('#toolbar-more');
  await page.waitForSelector(`#toolbar-overflow ${selector}`, { state: 'visible' });
}

/** `selectOption`, reaching into the overflow panel when it has to. */
export async function selectControl(page: Page, selector: string, value: string): Promise<void> {
  await reveal(page, selector);
  await page.selectOption(selector, value);
}

/** `click`, reaching into the overflow panel when it has to. */
export async function clickControl(page: Page, selector: string): Promise<void> {
  await reveal(page, selector);
  await page.click(selector);
}

/** `fill`, reaching into the overflow panel when it has to. */
export async function fillControl(page: Page, selector: string, value: string): Promise<void> {
  await reveal(page, selector);
  await page.fill(selector, value);
}
