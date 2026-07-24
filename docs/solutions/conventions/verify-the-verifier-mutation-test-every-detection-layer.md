---
title: "Verify the verifier: mutation-test every layer built to catch silent failure"
date: 2026-07-20
category: conventions
module: test and CI verification infrastructure
problem_type: convention
component: testing_framework
severity: high
applies_when:
  - "Building or reviewing a test, CI workflow, or security guard whose job is to catch silent failure elsewhere"
  - "Writing a companion or regression test meant to stop a scan, parser, or normaliser from silently swallowing its input"
  - "Fixing a vacuous or all-skipped suite by flipping a gate (env var, skip flag) rather than proving the suite now runs and can go red"
  - "Adding a CI step to detect zero-assertion or all-skipped test runs"
  - "Claiming a security or correctness fix is covered because a regression test was added"
symptoms:
  - "node --test reports tests 0 / pass 0 and still exits 0, because every case sits inside describe(..., { skip: !ENV_VAR_NOBODY_SETS })"
  - "A CI workflow written to catch all-skipped suites can itself pass with zero tests executed"
  - "A guard asserts an empty violation list, so any change that shrinks its scanned input is a silent pass rather than a red build"
  - "A companion test has its own private read-and-match loop instead of calling the real scan, so it can never observe a regression in that path"
  - "Reverting the fix in the real code path alone leaves every test green"
related_components:
  - authentication
  - development_workflow
  - testing_framework
tags:
  - mutation-testing
  - vacuous-tests
  - silent-failure
  - ci-gates
  - security-testing
  - test-infrastructure
  - guard-coverage
---

# Verify the verifier: mutation-test every layer built to catch silent failure

## Context

Issue #5379 was an adversarial sweep of WorldMonitor's auth test surface. The headline finding was not any single broken test — it was that **four separate times in one PR (#5385), a layer built to detect silent failure had a silent failure of its own.** Each was found the same way: by deliberately breaking the detector and checking whether it noticed. None was found by reading the detector and judging it correct.

That recursion is the durable lesson. A guard, a CI gate, and an anti-vacuity test are all just code, and code that asserts "nothing is wrong" fails open by construction: when its input silently shrinks to nothing, it reports success louder than ever.

The four layers, each one the fix for the one above it:

**Layer 1 — the inert suite.** `tests/live-api-cache-auth-regression.test.mjs:104` wraps its entire body in `describe(..., { skip: !LIVE })`, where `LIVE = process.env.LIVE_API_CACHE_TESTS === '1'` (`:16`). Nothing in the repo ever set that variable — verified by grep across `.github/`, `package.json`, and `scripts/`, which returns only the workflow #5379 added. The file is matched by the `test:data` glob (`package.json:88`), so every CI run for months "passed" a file that executed zero assertions. Reproduced at the current tree: `node --test tests/live-api-cache-auth-regression.test.mjs` reports `tests 0 / pass 0 / fail 0` and **exits 0**. Per the #5379 sweep, an unconditional `throw` placed at the top of the describe also exited 0 — there is no assertion you can write *inside* a skipped block that rescues it.

**Layer 2 — the fix that could fail the same way.** The obvious fix is a scheduled workflow that sets the env var. That fix is one rename away from reintroducing the identical bug, because `node --test` exits 0 when every test skips. The suite's own self-check at `:113` (`assert.equal(LIVE, true)`) cannot help: it is *inside* the skipped describe. So the workflow does not assert "the command succeeded", it asserts **work happened** (`.github/workflows/live-api-cache-auth.yml:98-104`):

```yaml
set -o pipefail
node --test --test-reporter=tap tests/live-api-cache-auth-regression.test.mjs 2>&1 | tee /tmp/sweep.log
if ! grep -qE '^# pass [1-9]' /tmp/sweep.log; then
  echo "::error::Live sweep executed 0 assertions — the LIVE_API_CACHE_TESTS gate did not engage. The suite is inert, not passing."
  exit 1
fi
```

`--test-reporter=tap` is pinned explicitly rather than left to the default, because Node picks its reporter from TTY-ness — an implicit format change would silently break the grep and turn the anti-vacuity check into the vacuous pass it exists to prevent. Per the #5379 sweep this was verified in both directions: env var absent → exit 1 with the actionable `::error::`; present → exit 0 with 6 passing.

**Layer 3 — the guard blinded by its own helper.** `tests/no-non-timing-safe-secret-compare.test.mts` is the regression net for #3803 (a timing oracle on `RELAY_SHARED_SECRET`). It walks `api/`, greps each file for non-timing-safe secret comparisons, and asserts the violation list is `[]`. That shape means **anything that shrinks its input is a silent pass.** Its `stripComments` helper did exactly that: per the #5379 sweep it deleted 30.2% of `api/` by bytes across 174 files (worst cases `api/[...notfound].ts` at 88.2%, `api/mcp/types.ts` at 82.4%), because a `/*`-containing glob inside a `//` comment reads as a block-comment *opener* and swallowed 4160 bytes including `export interface RpcToolDef`. The mechanism is already documented — see `~/.claude/skills/test-ci-gotchas/reference/source-grep-test-strip-comments-eats-regex-literals.md` and the adjacent `docs/solutions/logic-errors/ttl-staleness-audit-must-ignore-comments.md`. The fix was to scan raw source.

**Layer 4 — the anti-vacuity test that was itself vacuous.** The companion added to prevent layer 3 from recurring plants a known-bad line into every `api/` file and requires the scan to flag every one. Its comment promised that "any future normalisation step that eats real code turns this test red." That was false: it had its own private `readFile` + `match` loop and never touched the real scan's code path. Proven by mutation — per the #5379 sweep, reintroducing the stripper into the real scan's line alone left **all four tests green, including the one whose entire job was to catch that.**

## Guidance

**A guard is not verified until you have broken it and watched it fail.** Reading a guard tells you what it intends. Only mutation tells you what it covers. This applies with full force to guards you just wrote to fix a guard — layers 2 and 4 above were both introduced *as fixes for vacuity* and both shipped vacuous.

The recurring smell that generates this whole family:

> **A negative assertion — asserting a list is empty, a count is zero, no match was found — passes silently when its input shrinks. Anything that can shrink the input must therefore be pinned by a separate, direct assertion.**

Skip conditions shrink the input to zero tests. Comment strippers and normalisers shrink it to a fraction of the source. Filters, allowlists, and `walk()` predicates shrink it to fewer files. Each is a lever that turns the guard off without turning CI red.

When you find a negative assertion whose input can shrink, use this three-part recipe. **Part 1 alone is necessary but not sufficient** — that is the layer-4 lesson, and it is the part most likely to be skipped:

**1. Route the real check and its companion through ONE shared seam.** In this codebase the seam is `normaliseForScan` (`tests/no-non-timing-safe-secret-compare.test.mts:131-133`), today deliberately the identity function. The real scan calls it at `:268`; the companion calls it at `:324`. A mutation to the seam now affects both, so the companion cannot stay green while the real scan goes blind. The seam's docstring states the rule: anything that ever transforms source before matching must go *here*, never inline at a call site.

**2. Add a direct property assertion.** Do not wait for a planted violation to happen to land in a swallowed region — state the violated property outright (`:309`):

```ts
if (normaliseForScan(source).length !== source.length) shrunk.push(rel);
```

This fails on the first byte lost, with a message naming the files, rather than depending on where the plant landed.

**3. Plant violations at THREE positions — top, middle, bottom.** A swallowing normaliser eats a *region*, not a whole file. The first version of this fix appended the violation only at the end, which would survive a stripper that ate the middle. Current form (`:317-323`):

```ts
const lines = source.split('\n');
const mid = Math.floor(lines.length / 2);
const candidates = [
  `${VIOLATION}\n${source}`,
  [...lines.slice(0, mid), VIOLATION, ...lines.slice(mid)].join('\n'),
  `${source}\n${VIOLATION}\n`,
];
if (!candidates.every((c) => pattern.test(normaliseForScan(c)))) missed.push(rel);
```

For CI gates specifically, the analogue of part 2 is **asserting that work happened, not that the command succeeded** — grep the runner's own output for evidence of executed assertions, and pin the output format explicitly so the evidence check cannot be broken by a default changing underneath it.

## Why This Matters

The failure mode is worse than having no guard, because a green vacuous guard actively buys confidence. `tests/live-api-cache-auth-regression.test.mjs` shipped, appeared in the `test:data` glob, and reported success on every CI run since it landed — while never once probing the production cache/auth posture it was written to protect after the #4497 incident. The secret-compare guard is the regression net for a real timing oracle (#3803), and for the period it ran with the stripper, a reintroduced oracle sitting in any of the swallowed 30% of `api/` would have gone unflagged.

Both guards' code was reviewed and looked correct. What made them fail was invisible to reading: in one case an env var nobody set, in the other a regex that behaved differently on real input than on the examples in its own docstring. Only running the mutation surfaced either one.

The layered version is the specific trap. After fixing layer 3, the natural feeling is that the problem is now handled — a test was added *specifically* to catch it. The mutation says otherwise. Treat "I just added a test to prevent this class of bug" as a claim requiring proof, not as the proof.

## When to Apply

Run the mutation check whenever you write or review:

- A test asserting a collection is empty, a count is zero, or no match was found — the core smell.
- Any source-scanning or lint-style guard that normalises, strips, filters, or preprocesses its input before matching.
- Any test or suite behind a `skip:` condition, env-var flag, or `describe.skipIf` — confirm something in the repo actually sets the flag, and that CI fails if it stops doing so.
- Any CI step whose success depends on a subprocess *doing* something, not merely exiting 0.
- Especially: any guard you are adding **as the fix for a previously-vacuous guard.** That is where the recursion lives.

Also apply when auditing existing green tests. "It has been passing for months" is consistent with "it has been executing nothing for months," and the two are indistinguishable from the CI dashboard. This dovetails with the existing standing rules to mutation-test every security fix before claiming coverage, and to test the real function against real data rather than a hand-picked sample.

## Examples

**Reproducing layer 1** — the inert suite, at the current tree with the flag unset:

```
$ node --test tests/live-api-cache-auth-regression.test.mjs; echo "exit=$?"
ℹ tests 0
ℹ suites 1
ℹ pass 0
ℹ fail 0
exit=0
```

Zero assertions, exit 0, green CI. `assert.equal(LIVE, true)` at `:113` sits inside the skipped describe and never runs.

**Reproducing the layer-4 mutation proof.** Copy the guard to a non-`.test.` filename so the `tests/*.test.mts` glob cannot pick it up mid-run, reintroduce the stripper into the shared seam, and run it:

```
$ sed -e 's|^function normaliseForScan(source: string): string {$|&\n  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");|' \
    tests/no-non-timing-safe-secret-compare.test.mts > tests/_mutation-probe.mts
$ npx tsx --test tests/_mutation-probe.mts
AssertionError: normaliseForScan DROPPED source for 127 file(s): api/[...notfound].ts,
  api/_agent-metadata.ts, api/_agent-tool-suggest.ts, api/_api-key.js,
  api/_bootstrap-public-tier.js. Anything the scan cannot see, it cannot flag —
  this is how the guard silently stops working.
$ rm tests/_mutation-probe.mts
```

The seam mutation now reds the companion and names the affected files. Before the #5379 fix, the same mutation applied to the real scan alone left every test green. Unmutated, the suite is `tests 4 / pass 4 / fail 0`.

Note the disposable-copy technique: mutating a live test file in a worktree shared with concurrent sessions risks another agent's run picking it up. A copy named outside the test glob, run explicitly and deleted, keeps the mutation invisible to everything else. (`__dirname`-relative paths still resolve, since the copy stays in `tests/`.)

**The fixed CI gate, both directions.** Per the #5379 sweep: with `LIVE_API_CACHE_TESTS` absent the workflow exits 1 carrying `::error::Live sweep executed 0 assertions — the LIVE_API_CACHE_TESTS gate did not engage. The suite is inert, not passing.`; with it set, exit 0 and 6 passing tests. The error text names the actual failure — *inert, not passing* — rather than a generic non-zero exit, so whoever sees it next does not have to rediscover the distinction.

**Status:** PR #5385 is open and CI-green as of 2026-07-20, not yet merged. The line references above are to that branch's tree.

## Related

This is not a new lesson so much as the fifth recurrence of one, which is itself the argument for
writing it down as a convention rather than another incident note:

- [`best-practices/test-guard-assertions-and-module-state-reset.md`](../best-practices/test-guard-assertions-and-module-state-reset.md)
  — the closest sibling, from PR #5369/#5370 two PRs earlier on this same auth surface. Same thesis
  on one arm ("a test that claims to cover a guard must actually reach that guard", and "confirm the
  guard is covered by temporarily removing it: the test must fail"), reached through different
  mechanisms (`JSON.stringify` coercing `Infinity` to `null`; a leaked module-state reset). Read
  together, the two docs say the discipline applies to production guards *and* to the test
  infrastructure that guards them.
- [`logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md`](../logic-errors/country-scope-filter-permissive-default-leaked-unattributed-alerts.md)
  — the "mirror test" failure: a test that re-implemented the filter locally and therefore verified
  its own reimplementation rather than the real function. Same root as layer 4 here (a companion
  with its own private code path), different surface.
- [`logic-errors/ttl-staleness-audit-must-ignore-comments.md`](../logic-errors/ttl-staleness-audit-must-ignore-comments.md)
  — the inverse mechanism, worth reading as a pair. There a static audit *over*-matched (prose
  comments parsed as config, so the audit skipped a seeder); in layer 3 here the guard
  *under*-matched (real code deleted before matching). Both produce a false pass.
- `~/.claude/skills/test-ci-gotchas/reference/source-grep-test-strip-comments-eats-regex-literals.md`
  — the mechanism behind layer 3 in full. Note this codebase is now on its **third** reuse of that
  broken `stripComments` shape, and unlike the earlier two it defeated a live security guard rather
  than merely failing an assertion.
- `~/.claude/skills/test-ci-gotchas/reference/static-grep-audit-test-undertested-by-only-matching-one-shape.md`
  — the companion smell: a static-grep audit passing while matching only one of the N shapes it
  claims to cover.

Standing rules this extends: *mutation-test every security fix before claiming coverage* ("a test
that stays green when the fix is reverted is not a test", PR #5290) and *test the real function
against real data* (PR #5311). The contribution here is that both apply to detectors themselves —
including a detector written moments ago as the fix for another detector.

Issues: #5379 (the sweep), #5385 (the PR), #3803 (the timing oracle the layer-3 guard protects),
#4497 (the cache/auth incident the layer-1 suite was written for). Filed during the sweep and
deliberately left unfixed: #5384, #5386.
