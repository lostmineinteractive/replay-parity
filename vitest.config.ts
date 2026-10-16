import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));

// Workspace packages resolve to their TypeScript sources in tests, so no build is needed first.
const alias = [
  {
    find: "@replay-parity/demo-reference",
    replacement: here("demo/reference-service/src/index.ts"),
  },
  {
    find: "@replay-parity/demo-candidate",
    replacement: here("demo/candidate-service/src/index.ts"),
  },
  { find: /^@replay-parity\/([a-z]+)$/, replacement: here("packages/$1/src/index.ts") },
];

export default defineConfig({
  resolve: { alias },
  test: {
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["packages/*/src/**/*.test.ts", "demo/*/src/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "integration",
          include: ["packages/*/test/**/*.int.test.ts", "demo/*/test/**/*.int.test.ts"],
          testTimeout: 30_000,
          hookTimeout: 30_000,
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts", "demo/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: {
        "packages/core/src/**/*.ts": {
          lines: 90,
          branches: 90,
          functions: 90,
          statements: 90,
        },
      },
    },
  },
});
