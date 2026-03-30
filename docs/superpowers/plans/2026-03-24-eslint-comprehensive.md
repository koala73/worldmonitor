# ESLint Comprehensive Lint Enhancement — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add ESLint 9 with type-checked rules, unicorn, and sonarjs to World Monitor; fix all existing violations upfront so CI passes clean.

**Architecture:** Single `eslint.config.mjs` at the repo root using flat config format with four stacked blocks: global ignores, TypeScript source (type-checked), sidecar/scripts (no type-checking), and test file relaxations. One documented `eslint-disable` comment is permitted (`'tauri://localhost'` in `local-api-server.mjs`). All other violations are fixed before merge.

**Tech Stack:** ESLint 9, typescript-eslint (unified package), eslint-plugin-unicorn, eslint-plugin-sonarjs, lint-staged

---

## File Structure

| Path | Action | Responsibility |
|------|--------|----------------|
| `eslint.config.mjs` | Create | Root flat config — four stacked blocks |
| `package.json` | Modify | Add `lint`, `lint:fix` scripts; add `lint-staged` config; add devDependencies |
| `.husky/pre-commit` | Modify | Add `npx lint-staged` after existing secret scan step |
| `.github/workflows/eslint.yml` | Create | CI job running `npm run lint` on all PRs |
| `src/**/*.ts` | Modify (violations) | Fix floating promises, explicit any, unicorn/sonarjs violations |
| `src-tauri/sidecar/local-api-server.mjs` | Modify | Add one documented eslint-disable for `'tauri://localhost'`; fix other violations |
| `scripts/**/*.mjs` | Modify (violations) | Fix unicorn/sonarjs violations |
| `api/**/*.js` | Modify (violations) | Fix unicorn/sonarjs violations |

---

## Chunk 1: Setup — packages, config, npm scripts

### Task 1: Install ESLint packages

**Files:**

- Modify: `package.json` (devDependencies)

- [ ] **Step 1: Install devDependencies**

```bash
npm install --save-dev eslint@9 typescript-eslint eslint-plugin-unicorn eslint-plugin-sonarjs lint-staged
```

Expected: `package.json` devDependencies gains `eslint`, `typescript-eslint`, `eslint-plugin-unicorn`, `eslint-plugin-sonarjs`, `lint-staged`. `package-lock.json` updated.

- [ ] **Step 2: Verify install succeeded**

```bash
npx eslint --version
```

Expected: `v9.x.x`

---

### Task 2: Write `eslint.config.mjs`

**Files:**

- Create: `eslint.config.mjs`

`★ Insight ─────────────────────────────────────`
ESLint 9 flat config is a JS module exporting an array. Later array entries override earlier ones for the same file. `parserOptions.projectService: true` tells typescript-eslint to auto-discover tsconfigs instead of requiring explicit `project` paths — this is the preferred approach for monorepo-style layouts where sidecar/scripts live outside the main tsconfig.
`─────────────────────────────────────────────────`

- [ ] **Step 3: Create `eslint.config.mjs`**

```js
// @ts-check
import tseslint from 'typescript-eslint';
import unicorn from 'eslint-plugin-unicorn';
import sonarjs from 'eslint-plugin-sonarjs';

export default tseslint.config(
  // Block 1: Global ignores
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'src-tauri/target/**',
      '.agent/**',
      'src/workers/ml.worker.ts',
      'src/generated/**',
      'convex/**',
    ],
  },

  // Block 2: TypeScript source — full type-checked rules
  {
    files: ['src/**/*.ts'],
    extends: [
      ...tseslint.configs.recommendedTypeChecked,
      ...tseslint.configs.stylisticTypeChecked,
    ],
    plugins: {
      unicorn,
      sonarjs,
    },
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      'no-console': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/localhost/]",
          message: "Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.",
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      // Unicorn overrides
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
    },
  },

  // Block 3: Sidecar + scripts — no type-checking
  {
    files: [
      'src-tauri/sidecar/**/*.mjs',
      'scripts/**/*.mjs',
      'api/**/*.js',
    ],
    extends: [
      ...tseslint.configs.recommended,
    ],
    plugins: {
      unicorn,
      sonarjs,
    },
    rules: {
      'no-console': 'off',
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/localhost/]",
          message: "Use 127.0.0.1 instead of localhost — WKWebView treats them as distinct origins.",
        },
      ],
      ...unicorn.configs.recommended.rules,
      ...sonarjs.configs.recommended.rules,
      'unicorn/prevent-abbreviations': 'off',
      'unicorn/no-array-reduce': 'off',
      'unicorn/filename-case': 'off',
    },
  },

  // Block 4: Test files — relaxed rules
  {
    files: ['**/*.test.*', 'e2e/**'],
    rules: {
      'no-console': 'off',
      'sonarjs/cognitive-complexity': 'off',
      'unicorn/no-process-exit': 'off',
    },
  },
);
```

- [ ] **Step 4: Verify the config loads without crashing**

```bash
npx eslint --print-config src/main.ts 2>&1 | head -5
```

Expected: JSON output beginning with `{` — no "Error" or "Cannot find" lines.

- [ ] **Step 5: Run lint and capture the raw violation count (do not fix yet)**

```bash
npx eslint . 2>&1 | tail -5
```

Expected: Non-zero exit with a summary line like `X problems (Y errors, Z warnings)`. Record this count — it's the baseline we'll drive to zero. (The `lint` script is added in Task 3; use `npx eslint .` here to avoid a missing-script error.)

---

### Task 3: Add npm scripts and lint-staged config

**Files:**

- Modify: `package.json`

- [ ] **Step 6: Add `lint` and `lint:fix` scripts to `package.json`**

In the `"scripts"` object, add after `"secrets:scan:staged"`:

```json
"lint": "eslint .",
"lint:fix": "eslint . --fix",
```

- [ ] **Step 7: Add `lint-staged` config to `package.json`**

Add at the bottom of `package.json` (before the closing `}`), after the `"bugs"` block:

```json
"lint-staged": {
  "*.{ts,js,mjs}": "eslint --fix --quiet"
}
```

- [ ] **Step 8: Verify `npm run lint` script resolves**

```bash
npm run lint -- --version
```

Expected: `v9.x.x`

- [ ] **Step 9: Commit the setup**

```bash
git add eslint.config.mjs package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: add ESLint 9 with typescript-eslint, unicorn, sonarjs

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 2: Auto-fix pass + localhost audit

### Task 4: Run the auto-fix pass

**Files:**

- Modify: `src/**/*.ts`, `src-tauri/sidecar/**/*.mjs`, `scripts/**/*.mjs`, `api/**/*.js`

`★ Insight ─────────────────────────────────────`
ESLint's `--fix` flag only rewrites files for rules that have a `fixable: code` or `fixable: whitespace` annotation. unicorn rules like `unicorn/prefer-ternary`, `unicorn/prefer-string-slice`, and `unicorn/no-useless-undefined` are all auto-fixable. `@typescript-eslint` stylistic rules (prefer-nullish-coalescing, prefer-optional-chain) are also auto-fixable. Rules like `no-floating-promises`, cognitive-complexity, and `no-explicit-any` are never auto-fixable — those require manual attention.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Run the auto-fix pass**

```bash
npm run lint:fix 2>&1 | tail -10
```

Expected: ESLint exits non-zero (remaining unfixable violations), but the summary line shows fewer problems than the baseline from Task 2, Step 5. Some files will show as modified.

- [ ] **Step 2: Verify typecheck still passes after auto-fixes**

```bash
npm run typecheck:all
```

Expected: Exit 0 — no TypeScript errors introduced by the auto-fixes.

- [ ] **Step 3: Capture remaining violation count**

```bash
npm run lint 2>&1 | tail -5
```

Record the new count. Remaining violations will be the manual fix targets.

- [ ] **Step 4: Commit the auto-fix pass**

```bash
git add -p
# Stage all modified src/, scripts/, api/, src-tauri/sidecar/ files
git commit -m "$(cat <<'EOF'
chore: eslint auto-fix pass (unicorn + stylistic rules)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

Note: Use `git add` on specific files/directories rather than `-A`. Stage: `src/` `scripts/` `api/` `src-tauri/sidecar/`.

---

### Task 5: Audit and fix localhost string literals

**Files:**

- Modify: Any file in `src/`, `scripts/`, `api/`, `src-tauri/sidecar/` containing the string `"localhost"`

- [ ] **Step 5: Find all localhost string literals**

```bash
grep -rn '"localhost"' src/ scripts/ api/ src-tauri/sidecar/ --include="*.ts" --include="*.mjs" --include="*.js"
```

Expected: A list of file:line occurrences. Examine each one.

- [ ] **Step 6: Triage each occurrence**

For each hit:

- **`src/`**: Replace `"localhost"` with `"127.0.0.1"` — these are WKWebView URL constructions and are always bugs per CLAUDE.md.
- **`src-tauri/sidecar/local-api-server.mjs` — `return 'tauri://localhost'`**: This is an intentional Tauri IPC origin. Add exactly this suppress comment above the line:

  ```js
  // eslint-disable-next-line no-restricted-syntax -- intentional: Tauri IPC origin; must not change to 127.0.0.1
  return 'tauri://localhost';
  ```

- **`hostname === 'localhost'`** in the same file: This is a variable comparison (not a string Literal node with the localhost value in the right position for the selector), so the rule will not fire — no change needed.
- **`scripts/` or `api/`**: Evaluate case-by-case. Test fixtures comparing against `"localhost"` may be intentional — if so, add a suppress comment with explanation. URL constructions should be changed to `"127.0.0.1"`.

- [ ] **Step 7: Verify no more unfixable localhost violations**

```bash
npm run lint -- --rule '{"no-restricted-syntax": "error"}' src/ scripts/ api/ src-tauri/sidecar/ 2>&1 | grep localhost
```

Expected: Only the one documented suppress in `local-api-server.mjs` — no other localhost hits.

- [ ] **Step 8: Commit localhost fixes**

```bash
git add src/ scripts/ api/ src-tauri/sidecar/local-api-server.mjs
git commit -m "$(cat <<'EOF'
fix: replace localhost literals with 127.0.0.1 (WKWebView compat)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 3: Manual violation fixes

### Task 6: Fix floating promise violations

**Files:**

- Modify: `src/**/*.ts` files flagged by `@typescript-eslint/no-floating-promises`

`★ Insight ─────────────────────────────────────`
`no-floating-promises` fires when an async call's returned Promise is not awaited and not explicitly voided. In UI event handlers that cannot be `async`, the correct fix is `void someAsyncFn()` — this makes the intent explicit. In contexts that *can* be `async`, prefer `await`. Never suppress this rule: unhandled rejected Promises are a common source of silent failures in production.
`─────────────────────────────────────────────────`

- [ ] **Step 1: Isolate floating-promise violations**

```bash
npm run lint -- --rule '{"@typescript-eslint/no-floating-promises": "error"}' src/ 2>&1 | grep "no-floating-promises"
```

Expected: List of `file:line:col` entries.

- [ ] **Step 2: Fix each violation**

For each location:

- If the containing function can be `async`, add `await`.
- If the containing function is a sync event handler (e.g., a `mousedown` callback), prefix the call with `void`: `void fetchData()`.
- If the call is already in a `.then().catch()` chain, the rule should not have fired — re-read the context.

- [ ] **Step 3: Verify floating-promise violations are gone**

```bash
npm run lint -- --rule '{"@typescript-eslint/no-floating-promises": "error"}' src/ 2>&1 | grep "no-floating-promises" | wc -l
```

Expected: `0`

- [ ] **Step 4: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
fix: await or void all floating promises in src/

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Fix explicit-any violations

**Files:**

- Modify: `src/**/*.ts` files flagged by `@typescript-eslint/no-explicit-any`

`★ Insight ─────────────────────────────────────`
`any` is viral — one `any` parameter silently disables type checking for everything that flows through it. The right replacement depends on context: `unknown` for values whose type genuinely isn't known yet (requires a type guard before use); a union type or generic when the shape is known but flexible; `Record<string, unknown>` for untyped object shapes. Never use `// @ts-ignore` as a workaround — that suppresses an entire line rather than narrowing the type.
`─────────────────────────────────────────────────`

- [ ] **Step 5: Isolate explicit-any violations**

```bash
npm run lint -- --rule '{"@typescript-eslint/no-explicit-any": "error"}' src/ 2>&1 | grep "no-explicit-any"
```

- [ ] **Step 6: Fix each violation**

Decision tree for each `any`:

1. Is the value from an external API response with no schema? → Use `unknown`, add a type guard or `as SpecificType` with a comment.
2. Is it a callback parameter type? → Use the specific event/callback type from the library (e.g., `MessageEvent`, `ErrorEvent`).
3. Is it a generic container? → Use `unknown` or a constrained generic `<T extends object>`.
4. Is it DeckGL/MapLibre layer data? → Use the library's own data types (`Feature`, `PickingInfo`, etc.).

- [ ] **Step 7: Verify no explicit-any remains**

```bash
npm run lint -- --rule '{"@typescript-eslint/no-explicit-any": "error"}' src/ 2>&1 | grep "no-explicit-any" | wc -l
```

Expected: `0`

- [ ] **Step 8: Commit**

```bash
git add src/
git commit -m "$(cat <<'EOF'
fix: replace explicit any with typed alternatives in src/

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Fix cognitive complexity violations

**Files:**

- Modify: Any function in `src/`, `scripts/`, `api/`, `src-tauri/sidecar/` exceeding sonarjs cognitive complexity 15

`★ Insight ─────────────────────────────────────`
Cognitive complexity (SonarJS) differs from cyclomatic complexity. It penalizes nesting depth heavily — an `if` inside a `for` inside an `if` costs 3 points, not 1. This makes it a better proxy for "how hard is this to read" than branch count alone. The target is complexity ≤15 per function. Common refactors: extract nested conditionals into named helper functions; replace deep `if/else` chains with early returns; split functions that do two distinct things into two functions.
`─────────────────────────────────────────────────`

- [ ] **Step 9: Isolate cognitive-complexity violations**

```bash
npm run lint -- --rule '{"sonarjs/cognitive-complexity": ["error", 15]}' src/ scripts/ api/ src-tauri/sidecar/ 2>&1 | grep "cognitive-complexity"
```

Expected: List of functions over complexity 15, with their scores.

- [ ] **Step 10: Refactor each over-complex function**

For each flagged function:

1. Read the full function body.
2. Identify the clearest extraction boundary — usually the deepest or most independent nested block.
3. Extract to a named helper in the same file.
4. Re-run lint on the specific file after each extraction to confirm the complexity dropped.

```bash
npm run lint -- src/app/data-loader.ts  # example: check a single file
```

- [ ] **Step 11: Verify all complexity violations are gone**

```bash
npm run lint -- --rule '{"sonarjs/cognitive-complexity": ["error", 15]}' src/ scripts/ api/ src-tauri/sidecar/ 2>&1 | grep "cognitive-complexity" | wc -l
```

Expected: `0`

- [ ] **Step 12: Run typecheck after refactors**

```bash
npm run typecheck:all
```

Expected: Exit 0 — complexity refactors must not break types.

- [ ] **Step 13: Commit**

```bash
git add src/ scripts/ api/ src-tauri/sidecar/
git commit -m "$(cat <<'EOF'
refactor: reduce cognitive complexity to ≤15 across src/ and sidecar

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Fix remaining unicorn and sonarjs violations

**Files:**

- Modify: Any remaining flagged files in `src/`, `scripts/`, `api/`, `src-tauri/sidecar/`

- [ ] **Step 14: Run full lint and capture remaining violations**

```bash
npm run lint 2>&1 | grep -v "^$" | tail -20
```

Expected: Any remaining violations from unicorn/sonarjs rules not covered by prior tasks.

- [ ] **Step 15: Fix remaining violations**

Common unicorn fixes:

- `unicorn/prefer-string-slice` → replace `.substring()` / `.substr()` with `.slice()`
- `unicorn/prefer-ternary` → replace simple `if/else` assignment with ternary
- `unicorn/no-lonely-if` → merge nested `if` into parent `else if`
- `unicorn/prefer-includes` → replace `.indexOf() !== -1` with `.includes()`
- `unicorn/prefer-number-properties` → replace `isNaN()` with `Number.isNaN()`

Common sonarjs fixes:

- `sonarjs/no-duplicate-string` → extract repeated string to a named constant
- `sonarjs/no-identical-functions` → extract identical function bodies to a shared helper

- [ ] **Step 16: Verify lint exits 0**

```bash
npm run lint
```

Expected: Exit 0 with no output (or only informational).

- [ ] **Step 17: Run typecheck one final time**

```bash
npm run typecheck:all
```

Expected: Exit 0.

- [ ] **Step 18: Commit remaining fixes**

```bash
git add src/ scripts/ api/ src-tauri/sidecar/
git commit -m "$(cat <<'EOF'
fix: resolve remaining unicorn and sonarjs violations

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Chunk 4: CI workflow + pre-commit hook + final gates

### Task 10: Update the pre-commit hook

**Files:**

- Modify: `.husky/pre-commit`

- [ ] **Step 1: Add `npx lint-staged` to the pre-commit hook**

Append after the `secrets:scan:staged` block (before the sidecar test block):

```sh
echo "Running lint-staged..."
npx lint-staged || exit 1
```

Full resulting `.husky/pre-commit`:

```sh
#!/usr/bin/env sh
cd "$(git rev-parse --show-toplevel)" || exit 1

echo "Running TypeScript typecheck (all configs)..."
npm run typecheck:all || exit 1

echo "Running staged secret scan..."
npm run secrets:scan:staged || exit 1

echo "Running lint-staged..."
npx lint-staged || exit 1

CHANGED_FILES="$(git diff --cached --name-only)"

if echo "$CHANGED_FILES" | grep -q "^package-lock\\.json$"; then
  echo "Running lockfile check..."
  npm run lockfile:check || exit 1
fi

if echo "$CHANGED_FILES" | grep -Eq "^(src-tauri/sidecar/|api/)"; then
  echo "Running sidecar tests..."
  npm run test:sidecar || exit 1
fi
```

- [ ] **Step 2: Verify lint-staged config resolves**

```bash
npx lint-staged --help 2>&1 | head -3
```

Expected: Usage text (not an error).

- [ ] **Step 3: Commit the pre-commit hook update**

```bash
git add .husky/pre-commit
git commit -m "$(cat <<'EOF'
chore: add lint-staged to pre-commit hook

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Add CI workflow

**Files:**

- Create: `.github/workflows/eslint.yml`

`★ Insight ─────────────────────────────────────`
The existing `lint.yml` uses a top-level `paths` filter (only runs on `*.md` changes). Adding the ESLint job there would mean JS/TS-only PRs never trigger it. A separate `eslint.yml` with no path filter runs on every PR. This mirrors the pattern used by `typecheck.yml` in this repo.
`─────────────────────────────────────────────────`

- [ ] **Step 4: Create `.github/workflows/eslint.yml`**

```yaml
name: ESLint

on:
  pull_request:
  push:
    branches:
      - main

jobs:
  eslint:
    if: github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
      - uses: actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f
        with:
          node-version: '22'
          cache: 'npm'
      - run: npm ci
      - run: npm run lint
```

Note: Use the same pinned commit SHAs for `actions/checkout` and `actions/setup-node` that are used in `typecheck.yml`.

- [ ] **Step 5: Commit the workflow**

```bash
git add .github/workflows/eslint.yml
git commit -m "$(cat <<'EOF'
ci: add ESLint job running on all PRs

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Final gate verification

**Files:** None modified — verification only.

- [ ] **Step 6: Run all quality gates**

```bash
npm run lint && npm run typecheck:all && npm run secrets:scan
```

Expected: All three exit 0.

- [ ] **Step 7: Verify the one documented eslint-disable is present and explained**

```bash
grep -n "eslint-disable" src-tauri/sidecar/local-api-server.mjs
```

Expected: Exactly one line containing `eslint-disable-next-line no-restricted-syntax` with an inline comment explaining the Tauri IPC origin.

- [ ] **Step 8: Confirm zero unexplained eslint-disable comments across the codebase**

```bash
grep -rn "eslint-disable" src/ scripts/ api/ src-tauri/sidecar/ | grep -v "tauri://localhost"
```

Expected: No output (zero results).

- [ ] **Step 9: Post-merge manual step — add `eslint` to branch protection required checks**

After the PR merges and the `ESLint` CI job has run at least once on `main`:

1. Go to `https://github.com/bradleybond512/worldmonitor-macos/settings/branches`
2. Edit the `main` branch protection rule
3. Under "Require status checks to pass before merging", search for `eslint` and add it

This is a manual GitHub UI step and cannot be automated from this repo.

---

## Success Criteria

- [ ] `npm run lint` exits 0 on a clean checkout
- [ ] `npm run typecheck:all` exits 0
- [ ] `npm run secrets:scan` exits 0
- [ ] `.github/workflows/eslint.yml` exists and the job passes in CI
- [ ] `eslint` job added to branch protection required checks for `main`
- [ ] Pre-commit hook runs `npx lint-staged` and auto-fixes trivial violations
- [ ] Zero unexplained `eslint-disable` comments; exactly one documented exception in `local-api-server.mjs`
