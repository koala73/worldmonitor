# U21 calibration capture handoff

U21 of [#10577](https://github.com/koala73/worldmonitor/issues/10577) is **incomplete**. No calibration fixture has been accepted yet. The October fixtures remain regression snapshots, not calibration inputs.

## Production prerequisite check, 2026-11-13

GET-only Redis reads at **09:18:35 UTC**, repeated at **09:21:56 UTC**, found:

- Structural prior: 208 countries, including all 37 capture targets.
- Full UCDP window: **2025-09-30 through 2026-09-30**, 365 days between endpoints. `complete: true`; no gap months or missing releases. October and November candidate releases are explicitly unpublished, outside this window.
- UCDP records: **2,514 recent sample events**, **6,600 country-day rows**, **366 daily-total rows**, and **2,397 party-month rows** representing **21,177 events** and **238,890 factual deaths**. The country-day activity rollup reports 241,331 because its legacy rule counts at least one death per event; it must not be equated to factual party deaths. Russia and Ukraine state parties resolve.
- Economic key: generated **08:50:14.561 UTC**, **25/31 measured**, with Qatar still publishing the old **3.4303403626763873%** currency depreciation.
- FX source key: fetched **09:14:17.700 UTC**, after #10613 merged as `e5c5c69f759ef4d3394e991d322672bcebd235da`. Qatar now has reliable `currency-api` daily history, latest and 90-day anchor both `0.2747252747252747`, implying zero depreciation. This verifies corrected source data, but the downstream economic key has not consumed it yet.

The calibration structural-completeness validator passes on these payloads. This does **not** clear the economic correctness prerequisite. No production seed, deployment, service edit or merge was performed by this work.

## Resume and delivery

1. Land the U21 capture-tooling PR on `main` with owner authorization. Capture must run from a released checkout; `cii-v15` has an in-progress formula and is rejected. This tooling PR changes no formula.
2. Re-read the production keys and source/deployment evidence. Require the economic key to consume the corrected FX input, preserve at least 25 measured countries, and report Qatar's corrected value. The producer's repository interval is hourly; do not force it without owner authorization. Recheck the prior and complete UCDP party window too.
3. From refreshed `main`, using its own dependencies and an explicitly supplied trusted `WM_SEED_ENV_FILE`, run:

   ```sh
   node --import tsx scripts/cii-capture-fixture.mts --calibration --target-set=37 --iran-events-enabled=false --wait-for-rebuild
   ```

   First verify the deployed `IRAN_EVENTS_ENABLED` setting; `false` above is conditional on production remaining unconfigured. The capture performs only Redis GETs, refuses missing/partial calibration inputs, preserves both maps and the complete UCDP payload, and requires exact reproduction of the stored released table. If a concurrent rebuild or moving input causes a mismatch, retry after inspecting the error. Never alter production timestamps or expected scores.
4. Capture again on a **different UTC date**. Compare `capturedAt` dates, not filenames or the stored table's clock. Two same-day reads do not meet U21.
5. Deliver both fixtures to `cii-v15`, bringing over the capture-tooling changes and producer reader support as necessary without changing the formula. Record `expected.v15` only through the integration line's `cii-table-diff.mts --write-expected`. Prove the stored released v14 table for all 31 from the released checkout and P9 on the integration line. Keep all October fixtures byte-for-byte.

U18 and formula changes remain out of scope. Do not mark U21 done until both different-day captures are committed to the integration line and its required checks pass.
