# U21 calibration capture handoff

U21 of [#10577](https://github.com/koala73/worldmonitor/issues/10577) is **incomplete**: one valid calibration capture exists for **2026-11-13 UTC**. A second genuinely different UTC date is required. October fixtures remain unchanged regression snapshots.

## Production evidence and first capture

GET-only reads at **09:18:35** and **09:21:56 UTC** initially found corrected Qatar FX history upstream but an old economic key (08:50:14.561 UTC, Qatar depreciation 3.4303403626763873%). No capture was accepted from those inputs.

A fresh read at **09:47:12.978 UTC** found the economic key naturally refreshed at **09:40:50.278 UTC**: **25/31 measured**, Qatar currency depreciation **0%**, using reliable `currency-api` history with the 90-day anchor `0.2747252747252747`. The prior covers 208 countries, including all 37 targets.

The complete UCDP window is **2025-09-30 through 2026-09-30**, exactly 365 days between endpoints, with `complete: true`, no gap months and no missing releases. October and November candidate releases are explicitly unpublished outside this window. It retains **2,514 recent sample events**, **6,600 country-day rows**, **366 daily-total rows**, and **2,397 party-month groups**, representing **21,177 events** and **238,890 factual deaths**. Legacy country-day activity reports 241,331 deaths because it clamps each event to at least one; those totals must not be equated. Russia and Ukraine state parties resolve.

At **09:50:19.269 UTC**, `seed-meta:intelligence:risk-scores` reported both Iran events and strike pressure live. The accepted capture therefore uses **`iranEventsEnabled: true`**.

The first fixture, **`2026-11-13T0952Z.json`**, was read at **09:52:18.324 UTC**, three seconds after the natural production build. The released scorer reproduces the stored **v14 table for all 31/31 countries**. Its capture target is 37 countries; full UCDP and both calibration maps are retained. No timestamp or expected v14 score was edited.

Capture provenance: an export of released `main@e5c5c69f759ef4d3394e991d322672bcebd235da`, with only the two capture harness files from PR #10616 at `884f6ad1a89bbff29735c012d0a720da51b0ab0a` overlaid. The scorer, server and shared source are byte-identical to that released main commit. The fixture belongs on `cii-v15`, with `expected.v15` recorded only by that branch's table-diff script. This does not imply the tooling PR was merged.

The first fixture is durably retained as [`tests/fixtures/cii/2026-11-13T0952Z.json`](https://github.com/koala73/worldmonitor/blob/570fd245b5ce47f7c3790e8eae574d7157dc455a/tests/fixtures/cii/2026-11-13T0952Z.json) on `codex/cii-calibration-fixtures`. Its delivery is [PR #10618](https://github.com/koala73/worldmonitor/pull/10618), targeting `cii-v15`; it is not yet merged. Resume by fetching that existing PR branch, preserve its first fixture, and add the second-day fixture there. Both captures must reach the integration line before U21 is done. Merge still needs separate owner authorization.

## Resume on a different UTC date

1. Refresh released `main` and the U21 capture harness. An in-progress integration scorer is rejected; do not relabel its output as released v14.
2. Re-read production inputs and deployment evidence. Require the complete UCDP party window, all 37 priors, corrected Qatar FX input and at least 25 measured economic countries. Verify the current deployed Iran-feed setting again.
3. With an explicitly supplied trusted `WM_SEED_ENV_FILE`, run from released source:

   ```sh
   node --import tsx scripts/cii-capture-fixture.mts --calibration --target-set=37 --iran-events-enabled=true --wait-for-rebuild
   ```

   The flag reflects the first capture's verified live setting; match production on the next capture. The script performs only Redis GETs, waits for a natural rebuild, rejects incomplete inputs and requires exact reproduction of the stored released table. Inspect any mismatch before retrying. Never adjust timestamps or expected scores to make a capture pass.
4. Compare **`capturedAt` UTC dates**. Another November 13 read does not satisfy the second-day requirement.
5. Deliver the second fixture to `cii-v15` without changing October fixtures. Record `expected.v15` through `scripts/cii-table-diff.mts --write-expected`, verify released v14 reproduction and integration P9, and monitor required checks on the exact PR head.

No production seeds, service edits, deployments or merges were performed. U18 and formula changes remain out of scope. Do not mark U21 done until both different-day captures are delivered to the integration line and required checks pass.
