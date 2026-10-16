# Changelog

All notable changes to this repository are recorded here. The format follows Keep a Changelog. Entries are grouped by build step while the project is unreleased.

## Unreleased

### Step 0: workspace scaffold

- Added the pnpm workspace with `packages/*` and `demo/*`, a shared strict TypeScript base config with project references, ESLint flat config with type checked rules, Prettier, and a Vitest root config with `unit` and `integration` projects and a 90 percent coverage gate on `packages/core`.
- Added the MIT license, a Makefile compatible with GNU Make 3.81, and empty shells for the six packages and the two demo services.
- Added `scripts/check-prose.sh`, which fails on em dashes in Markdown and on banned vocabulary anywhere in the tree, and `scripts/check-secrets.sh`, which fails when a git visible file contains an Anthropic API key prefix and prints only file names and line numbers.
- Pinned TypeScript 6.0 because typescript-eslint does not yet accept TypeScript 7. Pinned `@types/node` 22 to match the supported Node version.
