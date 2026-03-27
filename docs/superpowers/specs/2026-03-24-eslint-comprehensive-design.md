# ESLint Comprehensive Lint Enhancement — Design Spec

**Date:** 2026-03-24
**Status:** Approved (v2 — post spec-review fixes)

## Overview

Add ESLint with full type-checked rules, `eslint-plugin-unicorn`, and `eslint-plugin-sonarjs` to World Monitor. Covers both the TypeScript frontend (`src/`) and the Node.js sidecar + scripts (`src-tauri/sidecar/`, `scripts/`, `api/`). All existing violations are fixed upfront — no suppressions, no warnings (with one documented exception for the SSRF security guard).

## Architecture

Single `eslint.config.mjs` at the repo root using ESLint 9 flat config format. Four stacked config blocks:

1. **Global ignores** — `node_modules/`, `dist/`, `src-tauri/target/`, `.agent/`, `src/workers/ml.worker.ts` (also excluded from `tsconfig.json` — third-party ML model code), `src/generated/`, `convex/`
2. **TypeScript source** (`src/**/*.ts`) — full type-checked rules, parser pointed at `tsconfig.json`
3. **Sidecar + scripts** (`src-tauri/sidecar/**/*.mjs`, `scripts/**/*.mjs`, `api/**/*.js`) — recommended rules without type-checking, `console.*` allowed
4. **Test files** (`**/*.test.*`, `e2e/**`) — relaxed: `no-console` off, `sonarjs/cognitive-complexity` off, `unicorn/no-process-exit` off

**Note on `api/`:** Source files in `api/` use `.js` extension; test files use `.mjs`. The sidecar+scripts block targets `api/**/*.js` to cover source, not tests.

**Note on `convex/`:** Has its own `tsconfig.json` and is not part of the desktop build. Excluded from root ESLint crawl.

**Note on `src/generated/`:** Machine-generated client/server stubs. May contain `localhost` references in generated code. Excluded from linting.

## Packages

All added as `devDependencies`:

- `eslint@9`
- `typescript-eslint` (unified package — provides both parser and plugin; replaces separate `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser`)
- `eslint-plugin-unicorn`
- `eslint-plugin-sonarjs`
- `lint-staged`

## Rules

### Terminology

In ESLint 9 flat config with the `typescript-eslint` unified package:

- **Config spreads** are referenced via `tseslint.configs.*` (e.g., `...tseslint.configs.recommendedTypeChecked`) and spread into the config array.
- **Individual rule overrides** always use the `@typescript-eslint/` prefix in the `rules` object.

### TypeScript source (`src/**/*.ts`)

**Config spreads:**
- `tseslint.configs.recommendedTypeChecked` — full type-aware rules (requires `parserOptions.projectService: true`)
- `tseslint.configs.stylisticTypeChecked` — consistent type-level style

**Individual rule overrides:**

| Rule | Severity | Rationale |
|------|----------|-----------|
| `@typescript-eslint/no-floating-promises` | error | Async calls must be awaited or voided |
| `@typescript-eslint/no-explicit-any` | error | No `any` bypassing strict types |
| `@typescript-eslint/no-misused-promises` | error | No async functions passed where void expected |
| `no-console` | error | No debug output in frontend builds |
| `no-restricted-syntax` selector `Literal[value=/localhost/]` | error | WKWebView only allows `127.0.0.1`; `"localhost"` string literal is always a bug in `src/` |
| `unicorn/recommended` rules | error | Modern JS patterns (via plugin spread) |
| `sonarjs/recommended` rules | error | Cognitive complexity + bug patterns (via plugin spread) |

### Unicorn overrides (off)

| Rule | Reason |
|------|--------|
| `unicorn/prevent-abbreviations` | Codebase uses `el`, `btn`, `cfg` throughout |
| `unicorn/no-array-reduce` | Used extensively in data processing |
| `unicorn/filename-case` | Existing files use kebab-case (`ema-forecast.ts`) |

### Sidecar + scripts (`src-tauri/sidecar/**/*.mjs`, `scripts/**/*.mjs`, `api/**/*.js`)

- `tseslint.configs.recommended` (no type-checking — no tsconfig covers these files)
- `unicorn/recommended` + `sonarjs/recommended` (same overrides as above)
- `no-console: off` — server/CLI output is intentional
- `no-restricted-syntax` with `Literal[value=/localhost/]` still enforced

**SSRF guard exception:** `local-api-server.mjs` contains two relevant occurrences:

- `hostname === 'localhost'` — a variable comparison, not a string literal. The `Literal` AST selector will not fire on it. No suppression needed.
- `return 'tauri://localhost'` in `getSidecarCorsOrigin()` — this IS a string literal and WILL trigger the rule. This is an intentional Tauri IPC origin and must be preserved. This is the one documented `eslint-disable-next-line no-restricted-syntax` comment in the codebase, with an explanatory note referencing this spec.

### Test files (`**/*.test.*`, `e2e/**`)

- `no-console: off`
- `sonarjs/cognitive-complexity: off`
- `unicorn/no-process-exit: off`

## Scripts

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix"
```

`lint` becomes a first-class quality gate alongside `typecheck:all`, `lint:md`, and `secrets:scan`.

**`lint-staged` config in `package.json`:**

```json
"lint-staged": {
  "*.{ts,js,mjs}": "eslint --fix --quiet"
}
```

Note: `git add` is omitted — lint-staged v10+ automatically re-stages fixed files.

## CI

**New file: `.github/workflows/eslint.yml`** (separate from `lint.yml` which has a top-level `paths` filter for `*.md` — adding a non-path-filtered job there would not run on JS/TS-only changes):

- Trigger: `pull_request` (all paths)
- `ubuntu-latest` + Node 22
- Steps: `actions/checkout`, `actions/setup-node` (with `cache: npm`), `npm ci`, `npm run lint`

After the workflow is added, the `eslint` job must be added to GitHub branch protection required status checks for `main`.

## Pre-commit Hook

`.husky/pre-commit` is updated to run `npx lint-staged` after the existing `typecheck:all` and `secrets:scan:staged` steps. The hook installer script (`scripts/install-git-hooks.mjs`) only sets `core.hooksPath` and chmods existing files — it does not write hook content and does not need to change.

## Violation Fix Sequence

1. Install packages, write `eslint.config.mjs`, add `lint`/`lint:fix` scripts, update `.husky/pre-commit`
2. Run `eslint . --fix` — auto-fix majority (import style, prefer-const, unicorn idioms)
3. **`localhost` pass first** — audit all `Literal[value=/localhost/]` hits manually; confirm each is a bug before changing (security checks and test fixtures may be legitimate)
4. Fix remaining manual violations: floating promises → explicit `any`s → cognitive complexity refactors
5. `npm run typecheck:all` to verify no regressions from complexity refactors
6. Add `eslint.yml` CI workflow; add job to branch protection required checks
7. All gates green: `lint` + `typecheck:all` + `secrets:scan`

`sonarjs/cognitive-complexity` violations (functions over complexity 15) are refactored, not suppressed.

## Success Criteria

- `npm run lint` exits 0 on a clean checkout
- `npm run typecheck:all` still exits 0
- New `eslint.yml` CI job passes and is added to branch protection required checks
- Pre-commit hook auto-fixes trivial violations and blocks unfixable ones
- Zero unexplained `eslint-disable` comments in the codebase; one documented exception: `'tauri://localhost'` in `local-api-server.mjs`
