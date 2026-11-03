---
title: A per-test-file V8 coverage probe reports zero for every suite without failing
date: 2026-09-28
category: test-failures
module: tests
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "Every suite, including ones that import production modules, reports zero production files executed"
  - "NODE_V8_COVERAGE is set but the coverage directory stays empty, with no error from node or the test runner"
  - "Suites that run production code through vm, new Function, a data: URL import or a child process read as coverage-free"
root_cause: incomplete_setup
resolution_type: tooling_addition
tags: [v8-coverage, node-test, test-audit, coverage, sandbox]
---

# A per-test-file V8 coverage probe reports zero for every suite without failing

## Problem

Issue #8683 needed to prove that deleting text-matching test suites would not lower code coverage. The method was to run each test file alone under `NODE_V8_COVERAGE` and list the production files it executed. The first version of the probe reported zero production files for all 113 candidates. That looked like the expected answer, and it was wrong.

## Symptoms

- Every suite reported zero, including positive controls that import production code.
- The coverage directory stayed empty. Neither `node` nor `node --test` printed an error.
- Suites that did execute production code, through paths V8 does not attribute, still read as zero after the probe was fixed.

## What Didn't Work

- **Trusting a uniform result.** Zero for every one of the 113 candidates matched the hypothesis that these suites only read source text. No control had been run, so a broken probe and a correct hypothesis looked the same.
- **Writing coverage to `os.tmpdir()` or the session scratchpad.** Under the agent sandbox, writes from the test child processes to those directories are dropped without an error.

## Solution

Three changes made the probe trustworthy:

1. **Remove `NODE_TEST_CONTEXT` from the child environment; do not set it to an empty string.** Setting it to `''` was enough to stop coverage being written.

   ```js
   const env = { ...process.env, NODE_V8_COVERAGE: dir };
   delete env.NODE_TEST_CONTEXT; // an empty value still suppresses coverage output
   execFileSync(process.execPath, ['--import', 'tsx', '--test', file], { env });
   ```

2. **Write the coverage directory inside the worktree.** A gitignored path such as `node_modules/.cache/cov-*` worked.
3. **Fail closed, and run a positive control before the real run.** Throw if the coverage directory is empty after a run. Probe a suite known to import production code before trusting any zero. On 2026-09-28, `tests/acled-query-normalization.test.mts` executed 23 production files and `tests/511-rate-limit.test.mjs` executed 1.

A file counts as executed when any function range in its V8 coverage entry has `count > 0`. Filter to the repo root, then exclude `tests/` and `node_modules/`.

## Why This Works

- The empty control output was the only visible sign that the probe was broken. Making an empty directory an error means a broken setup can no longer produce a plausible zero.
- A zero is a real claim only once a suite known to execute production code reports nonzero.

V8 also attributes no coverage to code that runs outside the test process's normal module graph. That includes `vm.runInNewContext`, `new Function`, esbuild `transformSync` followed by a `data:` URL import, and spawned processes that run bash or node scripts. The #8683 review found three suites that read as zero but do execute production code: `story-cii-unavailable` (a `data:` URL import), `prepush-identity-gate` (a spawned shell script) and `umami-runtime-remediation` (`new Function`). Before calling a suite coverage-free, grep it for those patterns.

## Prevention

- Run a positive control and assert the coverage directory is non-empty before trusting any zero.
- Before treating a zero as proof that deleting a suite is safe, grep the suite for `runInNewContext`, `new Function`, `transformSync`, `data:text/javascript`, `spawn`, `execFile` and `execSync`.
- Removing a suite with zero coverage leaves line coverage unchanged: a suite can only lower coverage by the lines it alone executes. That argument holds only for suites that pass the checks above.

## Related Issues

- #8683: the text-matching suite audit that needed this measurement.
- #8685 and #8686: the pull requests that removed 36 of those suites using this evidence.
