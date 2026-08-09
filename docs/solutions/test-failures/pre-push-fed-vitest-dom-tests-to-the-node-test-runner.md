---
module: pre-push-gate
date: 2026-07-29
problem_type: test_failure
component: testing_framework
severity: high
symptoms:
  - "Any push touching tests/dom/*.test.mts fails the gate with a bare 'test failed' and no assertion output"
  - "The same file passes under npm run test:dom and fails under npx tsx --test"
  - "The failure reproduces on the unmodified file as first committed, so it is not specific to any change"
root_cause: config_error
resolution_type: workflow_improvement
related_components: [development_workflow, tooling]
tags: [pre-push, husky, vitest, node-test-runner, happy-dom, ci-gate, green-while-dead, test-routing]
---

# Pre-push fed vitest DOM tests to the node:test runner

## Problem

`.husky/pre-push` swept every changed test file into one runner. The repo has **two** runners that are not interchangeable, so every push touching `tests/dom/` failed inside the runner rather than in the test — and the gate was unpassable for that whole file class (#5795; fixed in PR #5801, merged 2026-07-29).

## Symptoms

```
✖ failing tests:
test at tests/dom/notifications-settings-web-push.test.mts:1:1
✖ tests/dom/notifications-settings-web-push.test.mts
  'test failed'
```

No assertion, no stack — because the file never ran. The tell is that the same file passes under its own runner:

```
$ npx tsx --test tests/dom/gate-action.test.mts     # fail 1, pass 0
$ npm run test:dom                                  # 5 files, 86 tests passed
```

## What Didn't Work

Reading the failure as a broken test. It reproduces on the unmodified file as first committed, so no amount of looking at the assertions explains it. The gate was also silent about the real cause, so the practical workaround people reach for is `--no-verify` — exactly the habit the gate exists to prevent.

`grep -n dom .husky/pre-push` returned nothing outside an unrelated comment: the hook had no awareness of the vitest suite at all.

## Solution

The two runners and what they own:

| Path | Runner | Why it cannot cross over |
|------|--------|--------------------------|
| `tests/dom/**` | vitest + happy-dom (`vitest.dom.config.mts:33`, `npm run test:dom` — `package.json:129`) | Files import `vitest` and reach components using `import.meta.glob`; only a Vite pipeline can transform that |
| `tests/*` | node:test via `tsx --test` (`npm run test:data` — `package.json:103`) | — |

`npm run test:data` globs `tests/*.test.mjs tests/*.test.mts` — single level, so it never picked up `tests/dom/`. Only the pre-push changed-file sweep had the bug:

```sh
# before — matches tests/dom/foo.test.mts and hands it to tsx --test
TESTS_CHANGED=$(echo "$CHANGED_FILES" | grep -E "^tests/.*\.test\.(mjs|mts)$" | ...)
```

The fix puts the split in `scripts/prepush-changed-tests.sh`, which decides ownership by prefix *before* filtering by extension (`scripts/prepush-changed-tests.sh:70`):

```sh
case "$file" in
  tests/dom/*) owner=dom ;;
  *) owner=node ;;
esac
[ "$owner" = "$want" ] || continue
printf '%s\n' "$file" | grep -qE '^tests/.*\.test\.(mjs|mts)$' || continue
```

**Both halves matter.** Dropping `tests/dom/` from the node sweep without running it elsewhere trades a loud false failure for a silent coverage gap, so the same script also owns the dispatch (`run-node` / `run-dom`), and the hook calls both unconditionally (`.husky/pre-push:380-381`).

Note the extension trap: the DOM config includes `tests/dom/**/*.test.{mts,mjs}`, so a partition that routes only `.mts` to vitest while excluding all of `tests/dom/` from the node sweep strands a `tests/dom/*.test.mjs` in **neither** runner.

## Why This Works

Ownership is a property of the directory, not the extension, and it is declared in exactly one place. The hook can no longer drift back to a single glob, and the partition's two modes are total and disjoint over the changed-test set — a property the test asserts directly, because "in neither list" is the failure mode that replaces the one being fixed.

## Prevention

This change *is* a merge-blocking gate, so its risk is not blast radius — it is fidelity. Attacking it for **"can this report green while the thing it guards never ran?"** (own pass plus an independent cross-model pass) found five ways it could. Each is a reusable trap:

1. **A source-regex wiring guard false-passes.** While the hook held `if [ -n "$DOM_TESTS_CHANGED" ]` inline, the only available guard was grepping the hook's text. Flipping `-n` to `-z`, or dropping `|| exit 1`, left every assertion green while a DOM-only push skipped the suite *and stamped the tree gate-green*. Fix: move the decision into a script and execute it against stubbed runners on `PATH`, asserting what was invoked:

   ```js
   const { status, invocations } = runDispatch('run-dom', ['tests/dom/gate-action.test.mts']);
   assert.equal(invocations, 'npm run test:dom');
   ```

2. **Command substitution discards exit status.** `TESTS_CHANGED=$(... | helper node)` substitutes to an empty string when the helper is missing or errors — and empty reads as "no test files changed", so the gate skips everything and says nothing. Use `if ! VAR=$(...); then` and fail loudly.

3. **Nothing pinned what the npm script does.** The hook calls `npm run test:dom`; rewritten to a successful no-op it takes the hook *and* CI green with vitest never running. Assert the script body: `assert.match(pkg.scripts['test:dom'], /vitest run --config vitest\.dom\.config\.mts/)`.

4. **A config-coupling guard that scans for tokens it already expects proves nothing.** An earlier version matched the include globs for `mts|mjs`, so adding `tests/dom/**/*.test.js` or `**/*.spec.mts` stayed green while those files matched vitest and neither partition. Build a concrete path from each resolved glob and ask the real script who owns it.

5. **Guard the whole contract, not one file.** The routing contract spans four files — the hook, the partition script, `vitest.dom.config.mts`, and `package.json`. Triggering the test only on the partition script left the assertions absent exactly when the contract they pin was being rewritten.

Every one of the above was mutation-tested: reverted, observed red, restored, observed green. A guard you have not watched fail is not yet a guard.

**Do not import `vitest/config` from a `tests/*.test.mjs` file.** Measured at ~220 MB RSS, and `npm run test:data` runs ~390 files in one `tsx` process that already OOMs at the tail in a worktree. Resolve the config in a child process instead — it keeps the assertion against the real resolved value (not scraped source text) at a ~4 MB parent cost.

## Related

- Pre-existing hook-wide hazards where the green-tree cache can attest a tree the gates never ran against (worktree-vs-HEAD drift, `core.quotePath` dropping exotic paths, the `RUN_ALL` fallback caching a partial run): issue #5800.
- The `tests/dom` project itself was introduced in #5634; `vitest.dom.config.mts` documents why it is deliberately separate from the `tsx --test` profile.
