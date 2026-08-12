/**
 * The visual-test base: Playwright's `test`, extended so an uncaught page error fails the
 * test that caused it.
 *
 * This exists because of a bug 140 green tests did not notice. `setActivePane` began
 * touching a `let` declared further down the file, boot calls `setActivePane` while
 * restoring a layout, and the whole restore died on a temporal-dead-zone ReferenceError.
 * The only symptom was "the second pane came back on the wrong symbol" — every assertion
 * about panes, drawings and rendering still passed, because the app kept running.
 *
 * Several specs had been checking a `window.__errors` array that nothing ever populated,
 * which is worse than no check at all: it reads like coverage and asserts nothing.
 *
 * Console errors are collected too but only reported, not failed on: a page can log an
 * error for reasons outside the app's control (a blocked request, a WebGL warning), and a
 * test suite that fails on those teaches people to ignore it.
 */

import { test as base, expect } from '@playwright/test';

export interface PageErrors {
  /** Uncaught exceptions and unhandled rejections, in order. */
  readonly thrown: readonly string[];
  readonly logged: readonly string[];
}

export const test = base.extend<{ pageErrors: PageErrors }>({
  pageErrors: [
    async ({ page }, use, testInfo) => {
      const thrown: string[] = [];
      const logged: string[] = [];
      page.on('pageerror', (error) => thrown.push(String(error)));
      page.on('console', (message) => {
        if (message.type() === 'error') logged.push(message.text());
      });

      await use({ thrown, logged });

      // Only when the body itself passed: a test that already failed has a better story
      // to tell than "and there was also an exception".
      if (testInfo.status === testInfo.expectedStatus) {
        expect(thrown, `uncaught page error(s):\n${thrown.join('\n')}`).toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
