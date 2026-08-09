---
title: "Redundant parsing and unstubbed production timing waits drove ~9 minutes of CI test-suite wall time per PR"
date: 2026-08-07
category: performance-issues
module: "CI test suite (unit test runner + Playwright smoke)"
problem_type: performance_issue
component: testing_framework
symptoms:
  - "CI's `unit` job (`npm run test:data`, 1212 files via `tsx --test`) took ~5 minutes per PR, with `test:data` itself measured at 3m14s"
  - "CI's `variant-smoke-full` Playwright job took ~4m40s per PR, with the news-budget spec alone accounting for 2m33s"
  - "Per-test durations from the CI spec-reporter log showed 67% of 1,906 CPU-seconds concentrated in tests running longer than 1 second"
  - "The same 2.1MB docs/api/worldmonitor.openapi.yaml was YAML-parsed by 15 separate test processes (one file 13x), and tests/_lib/import-graph-walk.mjs re-read and re-stripped every file on every BFS pass (up to 8 passes per Railway service) with no caching"
  - "Tests stubbing failures (429 retries under `withRetry`, `yahooGate`/`finnhubGate` spacing) and Playwright's eight 8s settle windows in the news-budget spec slept through real wall-clock delays despite the underlying fetches being fully mocked"
root_cause: missing_tooling
resolution_type: tooling_addition
severity: high
related_components:
  - tooling
  - development_workflow
tags: [ci-performance, test-suite, caching, memoization, playwright, idle-wait, redundant-parsing, retry-backoff]
---

# CI test time was mostly idle waiting and redundant parsing, not test work

## Problem

The `unit` job (`npm run test:data`) ran ~3m14s and the `variant-smoke-full` Playwright job ran ~4m40s, and both had been quietly getting slower as suites were added. The instinct in that situation is to shard the suite or raise the runner size — buy more parallelism to cover a growing serial cost.

Profiling said the cost was not test work at all. The unit job's spec output reports ~25k timed entries (~21.7k tests plus their suites) totalling 1,906 CPU-seconds, but 1,274s of that (67%) sat in entries taking longer than one second each — a few dozen tests out of twenty-five thousand. Every one of those hotspots turned out to be one of two things: a process re-doing an expensive pure computation that another process had already done (parsing the same 2.1 MB YAML bundle, re-reading and re-tokenizing the same source files across BFS passes, re-formatting the same string lists inside a nested loop), or a process sleeping through a real-world pacing delay that had no reason to exist under a fully stubbed transport (exponential retry backoff against a stubbed 429, a 600 ms inter-request gate against a stubbed fetch, eight-second Playwright settle windows stacked serially at one worker).

Sharding would have bought parallelism for work that should never have run. The actual fix was to delete the redundant work and neutralize the idle sleeps — which also makes local runs faster and, in one case, speeds up the production build script too.

## Symptoms

- `test:data` at ~3m14s in CI with no single test that "looked" slow — the cost was diffuse in the summary but sharply concentrated once per-test durations were ranked.
- `tests/generated-api-description-guard.test.mjs` alone burned 40.3s; `tests/openapi-examples-contract.test.mjs` parsed the same 2.1 MB spec thirteen times in one process.
- The six import-graph guard files (railway watch-path audit and its siblings) consumed roughly 75s of CI test time between them.
- `tests/seed-conflict-intel-no-source-exit0.test.mjs` took ~37s, of which ~12s per affected test was pure `setTimeout` idling — CPU near zero, wall time large.
- `fetchDividendProfile` tests idled ~1.2s each inside the Yahoo request gate with every `fetch` stubbed.
- `variant-smoke-full` at ~4m40s, of which `e2e/dashboard-news-request-budget.spec.ts` was 2m33s — the spec has eight 8-second settle windows plus two 3-second ones (`e2e/dashboard-news-request-budget.spec.ts:42` defines `SECOND_LOAD_SETTLE_MS = 8_000`; it is awaited at lines 337, 380, 446, 511, 589, 638, 675, and 707, with 3s waits at 681 and 723), and the job ran at one worker so those sleeps stacked end to end.

## What Didn't Work

**Tuning the YAML parser's options instead of replacing it.** The first attempt at the 2.1 MB bundle was to pass cheaper options to the `yaml` package (`uniqueKeys: false` and friends). That shaved about 20%. The lever was not the options — it was the parser: `js-yaml` loads the identical document roughly an order of magnitude faster (measured ratios ranged ~8x on an idle machine to ~20x under load; on CI runners the `yaml` parse cost multiple seconds per process, which is what the CI durations show), and the two produce a deep-equal document for this spec (verified after a JSON round-trip). Twenty percent off the wrong parser is noise next to picking the right one.

**A blanket test-context cap on retry backoff.** The obvious shape for the retry-sleep problem was the same `NODE_TEST_CONTEXT` collapse used elsewhere in the repo: when running under the node test runner, make `withRetry`'s sleeps ~0. That was rejected on inspection, because `tests/seed-utils-with-retry.test.mjs:250` asserts real elapsed backoff (`assert.ok(elapsed >= 900, ...)`), and line 321 asserts `>= 1900` for an honored `Retry-After`. A blanket cap would have turned both of those into assertions that can never fail — a guard silently defanged by a performance change. The fix became an explicit opt-in env knob that only the suites which want it set.

**Measuring on a busy machine.** Early local timings were contaminated by a concurrent `npm ci` and disagreed with each other run to run. Every number in this document was re-measured on a quiet machine; a perf measurement taken while another heavy process is running is not a measurement.

**Restoring a mutation with `git restore`.** While mutation-checking the CI wiring guard, a `String.replace` of the first occurrence in `package.json` mutated the wrong script line, and the attempt to undo it with `git restore` wiped the uncommitted real edit along with the mutant. Mutation tests on uncommitted work need file-copy backup and restore, never a git checkout of the file.

## Solution

**Profile first, from the data CI already emits.** The unit job's spec reporter prints a duration for every test. Downloading that job log and ranking every line over 900ms located every hotspot in minutes, with no instrumentation and no local repro. That ranking, not intuition, chose all six targets below.

**Whale 1 — parse the OpenAPI bundle once per tree, not once per process.** `tests/_lib/openapi-spec-cache.mjs` is a new shared loader. It reads the YAML source, keys a disk cache on a sha256 of the bytes (`tests/_lib/openapi-spec-cache.mjs:75`), and on a miss parses with `js-yaml` (`:33`, `:92`), writes the JSON through a temp file plus `renameSync` so concurrent test processes racing to warm the same entry can never read a half-written file (`:52-71`), and on every subsequent call — in this process or any other — replays it as a tens-of-milliseconds `JSON.parse` returning a fresh object per call (`:123-130`). A corrupted entry is detected by parsing it before use and falls through to a fresh parse (`:79-90`), and any cache failure at all degrades to a direct parse rather than an error, so the cache is an accelerator and never a dependency. Because the replay goes through JSON, `assertJsonRepresentable` (`:103-116`) fails loudly if a spec ever contains a Date, `undefined`, or a non-finite number rather than silently changing shape for consumers. Fifteen test files now import it; `generated-api-description-guard` went from 40.3s to 2.9s warm.

**Whale 2 — memoize the import-graph walk per file.** `tests/railway-watch-path-audit.test.mjs:282` runs up to eight BFS passes per service (`for (let pass = 0; pass < 8 && !converged; pass += 1)`) to reach its spawn-edge fixed point, and every service's walk revisits the same shared seeder modules. Before the fix each pass re-read and re-stripped every file, and `stripComments` (`tests/_lib/import-graph-walk.mjs:70`) is a character-by-character state machine, not a regex. `cachedSourceEntry` (`tests/_lib/import-graph-walk.mjs:26-35`) now caches the stripped source and extracted edges per path, keyed on `mtime+size` so a test that rewrites a fixture between walks still sees fresh content, exposed as `readStrippedSource` (`:38-40`) and `extractCachedEdges` (`:43-47`). The walk itself consumes the cached edges at `:351`, and the audit's three scanners now call `readStrippedSource` (`tests/railway-watch-path-audit.test.mjs:133`, `:193`, `:314`). The six walk-based guard files went from ~75s of CI test time to 4.4s combined, 392/392 passing.

**Whale 3 — hoist loop-invariant formatting out of a 2^10 subset enumeration.** In `scripts/build-crawlable-corpus.mjs`, `signalMetaDescriptionCandidates` (`:336`) enumerated every signal subset *inside* the subject × verb loops, so each mask's list was formatted twelve redundant times; the formatted list depends only on the mask, so it is now built once into `listByMask` (`:343`) before the loops, which keep their original nesting so candidate order is unchanged. `longestEligibleMetaDescription` (`:314`) sorted up to ~12k strings per call to take the head; it now takes a single linear pass keeping the first strictly-longest candidate — the same element a stable descending sort by length yields. Output identity against the old implementation was proven across 2,172 cases, including 264 inputs where both versions throw the same error (a session-local old-vs-new sweep against `git show HEAD:…`; the harness was not committed). The boundary test went from ~28s to 4.2s, and because this is production code, the corpus build script speeds up identically.

**Whale 4 — cap the retry sleep without faking the retry.** `scripts/_seed-utils.mjs:817` defines `withRetry(fn, maxRetries = 3, delayMs = 1000)`. The `seed-conflict-intel` suite stubs `fetch` as a persistent 429, so each failing Redis write chain slept 1s then 2s — about 12s per test of pure idle. `WM_SEED_RETRY_DELAY_MS` (`scripts/_seed-utils.mjs:837-848`) now caps *only* the sleep, and is dual-gated on `NODE_TEST_CONTEXT` so the knob is structurally inert outside the node test runner — a stray env var on a production seeder cannot disable backoff. The attempt count, the computed `wait` (including the `Retry-After` maximum at `:833-834`), and the warning logged at `:836` all stay real, so anything asserting on attempts or log text is untouched. It is set by exactly one file — `tests/seed-conflict-intel-no-source-exit0.test.mjs:36` — and deliberately not by `tests/seed-utils-with-retry.test.mjs`'s timing assertions, which still measure genuine backoff (that file also locks the knob's contract: capped sleep, unchanged attempt count). The conflict-intel file went from ~37s to under 7s, 21/21 passing.

**Whale 5 — collapse request-pacing gates under the test runner.** `yahooGate` and `finnhubGate` space outbound requests to avoid IP-level 429s, but under the node test runner every fetch is stubbed, so the spacing only idled the suite. `server/_shared/constants.ts:18` and `:38` now read `process.env.NODE_TEST_CONTEXT ? 1 : 600` and `? 1 : 350`, following the existing precedent in `server/_shared/rate-limit.ts:25`, `:30`, and `:34`. Queue ordering is preserved either way. `fetchDividendProfile` tests went from 16.2s to 0.3s.

**Whale 6 — overlap the Playwright settle windows and boot one dev server.** `playwright.config.ts:12-13` sets `workers: process.env.CI ? 4 : 1` with `fullyParallel: true`, so the fixed settle windows overlap in CI instead of stacking; local runs stay at one worker for deterministic ordering. A single `test:e2e:ci-smoke` script (`package.json:101`) runs all three smoke specs in one invocation, because `reuseExistingServer: false` (`playwright.config.ts:58`) means each separate `playwright test` run boots its own vite dev server — three steps paid three boots. `.github/workflows/test.yml:463-477` caches `~/.cache/ms-playwright` keyed on the resolved `@playwright/test` version; a hit skips the browser download but still runs `playwright install-deps chromium`, because the cache restores binaries, not the OS libraries `--with-deps` installs on a fresh runner. The single combined run replaces the three per-spec steps. Verified locally under `CI=1`: 41/41 in 1.9m with zero flaky retries.

**The wiring guard caught the consolidation, as designed.** `tests/ci-workflow-coverage.test.mts` asserted that a workflow runs `npm run test:e2e:mcp-grant`, and folding three steps into one broke that — the single test failure in the whole run, and exactly the failure that guard exists to produce. It was updated rather than relaxed: `test:e2e:ci-smoke` is now in `REQUIRED_PR_SCRIPTS` (`:33`), and `REQUIRED_CI_SMOKE_SPECS` (`:41-45`) pins all three spec paths, asserted as live shell argv tokens (`:375-389`) — not substrings, so a `#` that comments out the tail of the command at runtime cannot leave the guard green — along with `VITE_VARIANT=full`. Both mutants were verified red: a dropped spec and a `#`-truncated command line.

Full suite after the change: 21,722 of 21,729 passing locally — 6 pre-existing skips, and the one failure was the wiring guard correctly catching the smoke-step consolidation, fixed by the re-pin described above.

## Why This Works

Every one of these six is the same shape: work whose result was already known, or a wait whose reason did not exist in the test environment.

The spec cache is safe because the cache key *is* the content — a sha256 of the YAML bytes — so an edited spec cannot be served from a stale entry, and there is no invalidation policy to get wrong. Returning `JSON.parse` output per call rather than a shared object means a test that mutates the spec cannot leak into another test, which is what makes a cross-process cache acceptable in a suite where files run in arbitrary order. The `mtime+size` key on the import-graph cache plays the same role at file granularity: a fixture rewritten mid-test invalidates itself.

The retry knob works because it separates two things that a blanket cap conflates. What the seed suites need to be real is the retry *behavior* — how many attempts, what gets logged, what the computed wait would have been. What they do not need is to actually experience the wait. Capping only the `setTimeout` argument leaves every observable except elapsed wall time intact, which is precisely why the one test that asserts on elapsed wall time can safely opt out. The same reasoning licenses the `NODE_TEST_CONTEXT` gate collapse: the gate's purpose is to protect a real upstream from burst traffic, and there is no upstream when every fetch is stubbed.

The corpus changes are safe because they are provably the same function, not merely a faster one that looks equivalent. Hoisting `formatMetaDescriptionList` out of the subject × verb loops is valid because its input depends only on the mask, and the loop nesting was deliberately preserved so candidate order — which determines which of several equal-length candidates wins — is byte-identical. The linear-scan max keeps the *first* strictly-longest candidate, which is the head a stable descending sort by length produces. Identity was then confirmed empirically across the 2,172-case sweep including matching throws, rather than argued.

The Playwright fix works because that suite's cost is wall-clock waiting, not CPU. Four workers on a runner would help little if the tests were compute-bound; when a spec is dominated by ten fixed sleeps, adding workers overlaps the sleeps almost linearly. And collapsing three invocations into one removes two full vite dev-server boots that existed only as an artifact of how the steps were written.

## Prevention

**Profile before optimizing, using CI's own output.** The unit job's spec reporter already prints per-test durations; ranking that log for anything over ~900ms is a complete hotspot list in minutes, and it is authoritative for the environment that actually matters. Do this before reaching for sharding or a bigger runner — a suite that looks like it needs more parallelism usually has a handful of tests doing work that should not run at all.

**Never parse a multi-megabyte committed artifact per test process.** Route it through a shared loader with a content-hash disk cache so the tree pays the parse once. And check the parser: for this 2.1 MB document `js-yaml` beat the `yaml` package by roughly an order of magnitude on identical output, a difference no amount of option-tuning approaches. Two properties make such a cache safe to add — key on content, and hand back a fresh object per call.

**A suite that stubs a persistent upstream failure must also neutralize the real backoff.** The rule that keeps this honest: attempts stay real, logs stay real, only the sleep shrinks, and any test that asserts on elapsed time opts out by simply not setting the knob. Resist the blanket `NODE_TEST_CONTEXT` version — a global cap silently converts every timing assertion in the repo into a test that cannot fail.

**Repo-scan guards should pre-filter with a cheap substring before parsing an AST.** `tests/frontend-cii-legacy-api-guard.test.mts:45` skips any file that does not contain `country-instability` before calling `ts.createSourceFile` at `:46`. This is only sound when the substring is a strict superset of the offending pattern — an offending import must contain the module literal — and the guard must be re-proven red-green with a probe offender after adding the filter, which it was.

**Playwright suites dominated by fixed settle windows should raise workers in CI.** The cost model is wall-clock, not CPU, so overlapping sleeps is nearly free. Keep local at one worker for deterministic ordering. And prefer one invocation over several when `reuseExistingServer` is false — each extra `playwright test` command is another full dev-server boot.

**When you consolidate CI steps, expect the wiring guard to go red and keep its teeth when you fix it.** A guard asserting "some workflow runs script X" is doing its job when X disappears into a combined command. The correct update is not to delete the assertion but to move it down a level: require the new script *and* pin the list of things it must still invoke, then mutation-verify that removing one goes red. Otherwise the consolidation becomes the mechanism by which a regression guard stops running while CI stays green.

**Mutation-test with file-copy backups, never `git restore`.** On uncommitted work, restoring a mutated file from git wipes the real edit along with the mutant. Copy the file aside, mutate, verify red, copy back.

**Measure on a quiet machine.** Timings taken alongside a concurrent `npm ci` or a parallel test run are not measurements. Re-time each file after each change rather than trusting that a change "should be" faster — several of the numbers above were only trustworthy on the second, uncontended run.

**Dependency note:** `tests/_lib/openapi-spec-cache.mjs` imports `js-yaml`, which until this work resolved only as a hoisted transitive dependency of `markdownlint-cli2` (a pre-existing exposure — `tests/openapi-examples-contract.test.mjs` already imported it the same way). With fifteen test files now depending on it, `js-yaml` was promoted to a declared `devDependencies` entry so an unrelated dependency bump cannot break the contract suite.

## Related Issues

- [git-push-timeout-stale-core-hookspath](git-push-timeout-stale-core-hookspath.md) — prior art in this category for the same genre of fix: batch redundant per-invocation work, add content-keyed caching, profile per-step, and verify wall-time claims empirically.
- [vendor-sdk-hidden-retries-nested-retry-ladder](../integration-issues/vendor-sdk-hidden-retries-nested-retry-ladder.md) — the mirror-image lesson: retry/backoff timing crossing a mocked test seam. There the mock hid a production retry ladder; here the mock left production pacing running under tests that could not benefit from it.
- [pre-push-fed-vitest-dom-tests-to-the-node-test-runner](../test-failures/pre-push-fed-vitest-dom-tests-to-the-node-test-runner.md) — the repo's two-runner split (node:test vs Vitest) that the `NODE_TEST_CONTEXT` gate collapse relies on.
- Issue #5890 — an open variant-smoke-full flake in a degraded-digest retry assertion (fixed-wait request count); same spec family this work parallelized, distinct defect.
