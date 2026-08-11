import { defineConfig, devices } from '@playwright/test';

/**
 * Visual regression config. Every option here exists to make a screenshot
 * bit-deterministic — see tests/visual/README.md for why each one matters.
 */
export default defineConfig({
  testDir: './tests/visual',
  // Screenshots are order-independent, but a parallel run on a shared GPU-less
  // container produces flakier pixels than a serial one.
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  reporter: [['list']],
  snapshotPathTemplate: '{testDir}/__screenshots__/{arg}{ext}',

  use: {
    baseURL: 'http://127.0.0.1:4173',
    // Exercises the DPR path (RENDER_ALGORITHMS §1) — the most common blur bug.
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 2,
    contextOptions: { reducedMotion: 'reduce' },
    trace: 'off',
  },

  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.001,
      animations: 'disabled',
    },
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // `devices['Desktop Chrome']` carries deviceScaleFactor: 1 and project-level
        // `use` wins over the top-level block, so spreading it silently disabled the
        // DPR path this suite exists to exercise. Re-assert it after the spread.
        viewport: { width: 1280, height: 720 },
        deviceScaleFactor: 2,
        // This image ships Chromium at a pinned path (PLAYWRIGHT_BROWSERS_PATH) whose
        // build number need not match the @playwright/test release. Point at the
        // installed binary instead of downloading one; `npx playwright install` is
        // explicitly not available here. CHROMIUM_PATH lets CI override.
        launchOptions: {
          executablePath:
            process.env['CHROMIUM_PATH'] ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
        },
      },
    },
  ],

  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env['CI'],
    timeout: 60_000,
  },
});
