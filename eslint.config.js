// @ts-check
import tseslint from 'typescript-eslint';

/** Layer boundaries from docs/ARCHITECTURE.md §1: data must never import the renderer. */
const dataBoundary = {
  files: ['src/data/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/renderer/**', '**/ui/**', '**/interaction/**'],
            message:
              'src/data must not import the renderer, UI, or interaction layers (ARCHITECTURE.md §1). Data flows one way: data -> renderer.',
          },
        ],
      },
    ],
    'no-restricted-globals': [
      'error',
      { name: 'document', message: 'No DOM in src/data.' },
      { name: 'window', message: 'No DOM in src/data.' },
    ],
  },
};

/** The renderer is pure paint: types only from data, and no DOM construction. */
const rendererBoundary = {
  files: ['src/renderer/**/*.ts'],
  rules: {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          {
            group: ['**/data/store/**', '**/data/ws/**', '**/data/rest/**'],
            message:
              'src/renderer may import types from src/data/types only — never the store or transports (ARCHITECTURE.md §1).',
          },
        ],
      },
    ],
    'no-restricted-syntax': [
      'error',
      {
        selector:
          "MemberExpression[object.name='document'][property.name=/^(createElement|body|querySelector)$/]",
        message:
          'Root CLAUDE.md mandate #1: chart primitives are drawn on canvas, never built as DOM nodes.',
      },
      {
        selector: "AssignmentExpression[left.property.name='innerHTML']",
        message: 'Root CLAUDE.md mandate #1: no DOM construction in the renderer.',
      },
    ],
  },
};

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      '**/*.config.js',
      // Subagent git worktrees are separate checkouts of this branch. Without this,
      // `eslint .` lints other agents' in-progress code and reports it as this
      // repo's status — green here could mask a real failure, and their transient
      // breakage would surface as ours.
      '.claude/**',
    ],
  },
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // Mandate #6: no `any`, no non-null assertions in the load-bearing layers.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },
  dataBoundary,
  rendererBoundary,
);
