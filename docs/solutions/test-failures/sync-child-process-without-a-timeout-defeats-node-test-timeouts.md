---
title: "A sync child process without a timeout defeats node:test's per-test timeout"
date: 2026-11-09
category: test-failures
module: prepush-changed-tests-tests
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "Data test file still running after --file-timeout=300000ms (a test hung or a handle was left open): tests/prepush-changed-tests.test.mjs"
  - "The file reports `test at <file>:1:1` with `DOMException [AbortError]` and no subtest name"
  - "No local reproduction: 32 runs at concurrency 8 all finished in about 6s"
root_cause: async_timing
resolution_type: test_fix
tags: [flaky-test, execfilesync, spawnsync, child-process, timeout, node-test, run-data-tests, watchdog]
---

# A sync child process without a timeout defeats node:test's per-test timeout

## Problem

`tests/prepush-changed-tests.test.mjs` hung `unit-shard (2)` twice on 2026-11-07 (#10334). Each time the 300s file watchdog in `scripts/run-data-tests.mjs` aborted the file. Neither the hung test nor the hung child was ever named.

## Symptoms

- The run logs `Data test file still running after --file-timeout=300000ms` and fails `test at tests/prepush-changed-tests.test.mjs:1:1` with `AbortError`.
- No subtest output appears for that file, not even the tests that passed.

## What Didn't Work

- Reading the job log for the hung test name. node:test delivers a child file's events to the parent only when that file exits. A probe that listened for `test:start` on `run()` saw nothing from the file until the abort, so the runner cannot report which test was running.
- Reproducing locally. 32 runs at concurrency 8 on an 18-core Mac all finished in about 6s.

## Solution

Give every sync child a deadline (PR #10347):

```js
// A sync child blocks the event loop, so node:test's per-test timeout cannot
// fire while it runs.
const CHILD_TIMEOUT_MS = 60_000;

execFileSync('bash', [SCRIPT, mode], {
  input,
  encoding: 'utf8',
  timeout: CHILD_TIMEOUT_MS,
  killSignal: 'SIGKILL',
});
```

The timeout needs `killSignal: 'SIGKILL'` to bound the call. With the default `SIGTERM`, a child that ignores the signal still blocks the call until it exits on its own. A probe confirmed it: a script with `trap '' TERM` held a 300ms `execFileSync` deadline for 3030ms. With `SIGKILL` it threw `ETIMEDOUT` at 305ms, and also at 302ms when a grandchild still held stdout open. `SIGKILL` reaches only the direct child. That grandchild kept running, orphaned, after the call returned. The deadline frees the test, not the process tree.

When a wrapper catches child errors to read `err.status`, rethrow the timeout. Otherwise a hang reads as `status: null`:

```js
} catch (err) {
  if (err.code === 'ETIMEDOUT') throw err;
  status = err.status;
}
```

## Why This Works

`execFileSync` and `spawnSync` block the event loop until the child exits. node:test runs its per-test `timeout` (120s in `run-data-tests.mjs`) on a timer, and a timer cannot fire on a blocked loop. A probe confirmed it: a test with `timeout: 1000` around `execFileSync('sleep', ['1000'])` ran until the outer abort. With `{ timeout: 1500 }` on the child, the test failed under its own name at 1.5s. The deadline belongs to the child, because only the child call can unblock the loop.

## Prevention

- Pass `timeout` and `killSignal: 'SIGKILL'` to every `execFileSync`, `execSync` and `spawnSync` in a test. This also applies to probes that start `tsx` or a config import, which can keep a handle open and never exit.
- `spawnSync` does not throw on timeout. It returns `result.error.code === 'ETIMEDOUT'`, so a test that reads only `result.status` can pass after a timeout. Check `result.error` and throw it.
- To test that a deadline is wired, shrink it in a scratch copy, for example to 5 ms. Each spawning test that throws on `ETIMEDOUT` should then fail under its own name within milliseconds. A test that swallows the error will not, so check those by hand.
- When `run-data-tests` reports an unnamed `--file-timeout`, grep the file for sync children before anything else.
- 171 test files use sync children as of 2026-11-09. A repo-wide guard is not in place yet.

## Related Issues

- #10334 (open until a named recurrence or a quiet scan), PR #10347.
- PR #9904 added the file watchdog that names the file.
