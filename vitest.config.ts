import { defaultExclude, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      ...defaultExclude,
      // Subagent git worktrees under .claude/worktrees/ are full checkouts of this
      // branch, so their tests/**/*.spec.ts match the default glob and get collected
      // into this repo's run. Excluding them keeps `npm test` a measurement of THIS
      // working tree only.
      '**/.claude/**',
      // Playwright owns tests/visual. Vitest would happily collect those specs and
      // fail on `@playwright/test`'s runner globals.
      'tests/visual/**',
    ],
    include: ['tests/**/*.spec.ts'],
  },
});
