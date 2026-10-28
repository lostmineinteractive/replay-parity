import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to their TypeScript sources in tests, so no build is needed first.
const alias = [
  {
    find: '@replay-parity/demo-reference',
    replacement: here('demo/reference-service/src/index.ts'),
  },
  {
    find: '@replay-parity/demo-candidate',
    replacement: here('demo/candidate-service/src/index.ts'),
  },
  { find: '@replay-parity/demo-load', replacement: here('demo/load/src/index.ts') },
  { find: /^@replay-parity\/([a-z]+)$/, replacement: here('packages/$1/src/index.ts') },
];

export default defineConfig({
  resolve: { alias },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['packages/*/src/**/*.test.ts', 'demo/*/src/**/*.test.ts'],
          // Synchronous tests of a few hundred milliseconds took 7 seconds under CPU contention
          // on a shared machine, so the budget is raised from the default 5000. This changes
          // nothing about what passes on a quiet machine.
          testTimeout: 20_000,
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: [
            'packages/*/test/**/*.int.test.ts',
            'demo/*/test/**/*.int.test.ts',
            'scripts/test/**/*.int.test.ts',
          ],
          // Raised from 30 seconds for the same reason as the unit budget: tests of a few hundred
          // milliseconds took 7 seconds under CPU contention on a shared machine, and the longer
          // integration tests scale the same way.
          testTimeout: 60_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts', 'demo/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/index.ts', '**/testing.ts'],
      reporter: ['text', 'html', 'json-summary'],
      thresholds: {
        'packages/core/src/**/*.ts': {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
