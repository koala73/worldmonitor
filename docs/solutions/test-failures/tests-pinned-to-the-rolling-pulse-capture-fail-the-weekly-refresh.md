---
title: "Tests pinned to the rolling live-pulse capture fail the weekly refresh that replaces it"
date: 2026-10-12
last_updated: 2026-11-01
category: test-failures
module: crawlable-pulse-refresh
problem_type: test_failure
component: testing_framework
severity: medium
symptoms:
  - "crawlable-pulse-refresh.yml fails in 'Verify published artifacts' after a clean freeze, and the pulse-freshness monitor opens 'Crawlable pulse refresh: snapshot is going stale' (#9115)"
  - "tests/accuracy-corpus.test.mjs: ENOENT opening docs/snapshots/crawlable-live-pulse-2026-10-05.json, the file the refresh just deleted"
  - "tests/crawlable-corpus.test.mjs: 'The input did not match the regular expression /data-chokepoint-open-status>As of ... source coverage for the Strait of Hormuz is partial/' after Hormuz moved from a partial pulse to a published 76-transit count"
  - "The workflow still opens a draft PR carrying the capture (#9112), so the fix belongs in that branch"
root_cause: test_fixture_drift
resolution_type: test_fix
related_components: [documentation, development_workflow, data_pipeline]
tags: [crawlable-pulse, weekly-refresh, snapshot-pinning, test-fixture-drift, hormuz, forecast-scorecard, false-red, resilience-snapshot, monthly-refresh, refresh-verify-gate]
---

# Tests pinned to the rolling live-pulse capture fail the weekly refresh that replaces it

## Problem

`docs/snapshots/crawlable-live-pulse-<date>.json` is not a fixture. The weekly refresh deletes the old file, commits a new one, and the corpus build reads whichever is newest. Any test that names the file by date, or asserts what one capture happened to contain, holds for exactly as long as that capture stays committed. This is the fifth refresh broken by the same class (#7533, #7884, #8345, #8417, and now #9115).

## Symptoms

Run 38206177440 on 2026-10-12 froze a good capture and failed verification on two tests:

- `tests/accuracy-corpus.test.mjs` read `crawlable-live-pulse-2026-10-05.json` by name to prove the renderer prints no `#5233` correction note for a pre-correction capture. The refresh deleted that file (ENOENT), and the 2026-10-12 methodology carries the note, so the premise itself had expired.
- `tests/crawlable-corpus.test.mjs` pinned the Hormuz page to the 2026-10-05 values: score 70 (Red), partial coverage, no transit count, 0 AIS disruptions, and the withheld-count sentence. The new capture publishes 76 transits at score 85 with full coverage.

Both passed for five weeks only because Hormuz did not change between captures.

## What Didn't Work

Re-running the workflow. A re-freeze reads the same live API and produces the same capture; the capture was correct and the tests were wrong. Hand-editing the pinned numbers to the new capture would have reset the clock for one week.

## Solution

Derive every expectation from the committed pulse the build actually used, and keep per-capture facts out of literals:

- In `crawlable-corpus.test.mjs`, the build test already holds `clock = await loadCorpusData(...)`; read `clock.livePulse.chokepoints.hormuz_strait` for the score and band, and branch on `todayCountsAvailable === true && todayTransits != null` for published-versus-withheld transit assertions. The per-chokepoint loop later in the file (`chokepointEvidenceNarrative` against every page) already proves the exact narrative, so the Hormuz block only needs the policy shape: an `As of` lead and one of the two non-verdict closing sentences.
- In `accuracy-corpus.test.mjs`, resolve the capture with `resolveLatestLivePulseSnapshotPath(repoRoot)` (already imported there) and assert the correction note appears exactly when `capture.scorecard.methodology` carries it. The pre-correction case renders `LIVE_SCORECARD.methodology`, the real methodology captured the day the page shipped.

Fixed in PR #9112 on the automation branch the workflow opened. Both rewritten tests were run against the 2026-10-05 and 2026-10-12 captures before pushing, so each branch of the conditional is exercised.

## Prevention

- Never name a dated pulse file in a test. Use `resolveLatestLivePulseSnapshotPath`, `loadCorpusData().sources.livePulseSnapshot`, or `clock.livePulse`.
- Never assert a chokepoint's score, band, transit count, congestion, or warning count as a literal. Read it from the pulse, or use `tests/fixtures/crawlable-live-pulse-fixture.json` through `livePulseSnapshotPath` when the test needs a fixed state.
- A test that encodes "the committed capture predates change X" has a built-in expiry. Encode the pre-change state as an inline constant instead.
- When the refresh fails in verification, fix the test in the draft PR the workflow opened; it will not re-freeze a week whose PR exists.

## Recurrence and the structural fix (2026-10-26)

The prevention list above did not stop the sixth instance. PR #9693 failed on `data-cii-methodology-version="v8"` and the lede's `CII v8 currently monitors 31 countries`, two literals in `crawlable-corpus.test.mjs` written on 2026-09-01 (#7491). They held for eight weeks because every capture carried v8, then broke on the first capture after CII moved to v14. A rule a reviewer has to remember cannot catch a pin that only fails when the live value moves.

`scripts/rehearse-crawlable-pulse-refresh.mjs` moves those values first. It writes a drifted copy of the committed capture (re-dated to today, every `vN` methodology version bumped, CII readings rotated across scored countries, chokepoint readings rotated across chokepoints) and runs the refresh workflow's own `Rebuild published artifacts` and `Verify published artifacts` steps, parsed from `crawlable-pulse-refresh.yml`. `crawlable-pulse-rehearsal.yml` runs it on every PR that touches the capture, the corpus generators, or a verify test, and `tests/rehearse-crawlable-pulse-refresh.test.mjs` fails if the verify list gains a test that the rehearsal's path filter misses. Run against `main` before the fix, it failed on exactly the `v8` pin using only the old v8 capture, so it would have caught the pin on #7491.

When the rehearsal fails, run `node scripts/rehearse-crawlable-pulse-refresh.mjs --keep` locally to inspect the drifted capture and rebuilt pages, then `git restore . && git clean -fd docs/snapshots` to undo.

## The monthly resilience snapshot (2026-11-01)

The same class reached the monthly CRI refresh. `resilience-snapshot-refresh.yml` opened #9954 red: `crawlable-corpus.test.mjs` pinned three figures from the 2026-08-29 `resilience-ranking-*.json` snapshot. They were Norway's overall score (75.4), Taiwan's coverage (38%) and Andorra's coverage (69%). The November snapshot moved all three. CI reported only the first assertion; the other two surfaced one at a time on local reruns, so run the suite until green rather than fixing the CI-reported line.

Two gaps let it through:

- **The pins.** The fix derives each figure from the snapshot the pages are built from: `JSON.parse(read(repoRoot, manifest.sources.resilienceSnapshot))`. Headline-eligible countries are in `items`; ineligible ones such as Taiwan are in `greyedOut`. Percentages use the page's `Math.round(x * 100)` and scores the `toFixed(1)` rule minus a trailing `.0`. Assert the fixture country's eligibility too, so a country changing class fails loudly instead of matching vacuously.
- **The gate.** The workflow verified with a hand-picked list of eight suites that omitted `crawlable-corpus.test.mjs`, so the red appeared only after the PR existed. #9957 replaces the list with every suite whose source matches the `SNAPSHOT_CONSUMERS` pattern on the verify step (106 at the time), run through `scripts/run-data-tests.mjs`. Do not pass `--built-output=exclude` there: it drops whole suites that merely reference built output, which removed 12 of the 106, including `public-product-facts` and `seo-landing-metadata` from the old list. The refresh job never builds, so those suites skip only their build-dependent cases.

The gate turns a red PR into a failed workflow run, so a new pin now blocks that month's snapshot instead of shipping it red. Unlike the pulse refresh, this workflow has no drift rehearsal that would catch a pin before the next monthly run.
