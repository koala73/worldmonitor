---
title: "Tests pinned to the rolling live-pulse capture fail the weekly refresh that replaces it"
date: 2026-10-12
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
tags: [crawlable-pulse, weekly-refresh, snapshot-pinning, test-fixture-drift, hormuz, forecast-scorecard, false-red]
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

Fixed in PR #9112, commit 073af50e6, on the automation branch the workflow opened. Both rewritten tests were run against the 2026-10-05 and 2026-10-12 captures before pushing, so each branch of the conditional is exercised.

## Prevention

- Never name a dated pulse file in a test. Use `resolveLatestLivePulseSnapshotPath`, `loadCorpusData().sources.livePulseSnapshot`, or `clock.livePulse`.
- Never assert a chokepoint's score, band, transit count, congestion, or warning count as a literal. Read it from the pulse, or use `tests/fixtures/crawlable-live-pulse-fixture.json` through `livePulseSnapshotPath` when the test needs a fixed state.
- A test that encodes "the committed capture predates change X" has a built-in expiry. Encode the pre-change state as an inline constant instead.
- When the refresh fails in verification, fix the test in the draft PR the workflow opened; it will not re-freeze a week whose PR exists.
