---
module: reservoir-levels
date: 2026-11-12
problem_type: logic_error
component: data_pipeline
severity: medium
symptoms:
  - ATL13 and ATL06 observations of the same overpass have different reference ground tracks
  - Track-history despiking groups ATL13 passes by the source granule track
root_cause: upstream_field_semantics
resolution_type: code_fix
tags: [icesat2, atl13, sliderule, reservoir-levels, pass-identity]
---

# ATL13 segment ground track versus granule metadata

SlideRule v5.8.0 initializes its default ATL13 `rgt` from the granule filename.
ATL13 granules span enough time that this can differ from the track flown over
the reservoir. The [NASA ATL13 V007 data dictionary](https://nsidc.org/sites/default/files/documents/technical-reference/icesat2_atl13_data_dict_v007.pdf)
defines a per-segment `/<beam>/rgt`. Requesting `rgt` as an ancillary field reads
that array; it must supply the UTC-date + RGT pass key and the track history used
by the despiker.

## Source verification

Read-only requests on 2026-11-12 used SlideRule v5.8.0 (`93e05390`). Three
single-granule core-polygon subsets returned the same segment counts and reduced
heights with the default CSV route and the native ancillary-column route:

| Reservoir | ATL13 V007 granule | Filename/default RGT | Segment RGT | Source segments | Reduced level (m) |
| --- | --- | ---: | ---: | ---: | ---: |
| Lake Mead | `ATL13_20181118180604_07810101_007_01.h5` | 781 | 783 | 409 | 328.965 |
| Tharthar | `ATL13_20181129053216_09410101_007_01.h5` | 941 | 944 | 424 | 42.559 |
| Atatürk | `ATL13_20181217195036_12250101_007_01.h5` | 1225 | 1226 | 128 | 530.132 |

Separate generic SlideRule `h5x` reads of the HDF5 `rgt`, `atl13refid`, latitude
and longitude arrays selected the same 409, 424 and 128 segments, respectively,
all on tracks 783, 944 and 1226. These verify the source field independently of
the ATL13 dataframe adapter.
No fixed numeric correction is applied: every segment carries its own RGT,
including across orbit boundaries.

Relevant upstream implementation, pinned to the observed release:

- [ATL13 dataframe columns and granule metadata](https://github.com/SlideRuleEarth/sliderule/blob/v5.8.0/apps/node/datasets/icesat2/package/Atl13DataFrame.cpp)
- [Proxy dataframe assembly](https://github.com/SlideRuleEarth/sliderule/blob/v5.8.0/apps/node/packages/core/extensions/dataframe.lua)
- [Native dataframe wire layout](https://github.com/SlideRuleEarth/sliderule/blob/v5.8.0/apps/node/packages/core/package/GeoDataFrame.h)

## Request and response contract

The v5.8 proxy fails when merging an ancillary `rgt` column with same-named
scalar metadata. Aliasing the HDF5 path as `./rgt` or `/rgt` fails the upstream
reader. Instead, send one resource directly to `/source/atl13x`:

```json
{
  "resource": "ATL13_20181118180604_07810101_007_01.h5",
  "key_space": 0,
  "parms": {
    "poly": [{"lon": -114.84, "lat": 36}, {"lon": -114.06, "lat": 36}, {"lon": -114.06, "lat": 36.3}, {"lon": -114.84, "lat": 36.3}, {"lon": -114.84, "lat": 36}],
    "atl13": {"anc_fields": ["atl13refid", "rgt"]}
  }
}
```

The polygon is the committed Mead `core` converted by `bboxToPolygon`.
Do not request CSV output. Native
`geodataframe` records distinguish column `rgt` from metadata `rgt`. Read
`time_ns`, `rgt`, `ht_ortho`, `atl13refid` and beam metadata `gt`; verify all six
beam EOFs, column lengths, encodings and record framing before emitting rows.
Source-granule read errors remain retryable granule failures; malformed or
truncated streams remain request failures. ATL06 keeps its existing CSV path.

Remove the single-resource workaround only after a deployed proxy can preserve
both identities and passes the captured-source and incomplete-stream tests.

## Regression fixture provenance

`tests/fixtures/reservoir-levels/mead-atl13-native-2018-11-18.bin` is a subset of
the real native response above, using the committed Mead core polygon. It keeps
only the four consumed columns, `gt` and `rgt` metadata, and six EOF records.
Record headers and retained values are unchanged. It contains 409 source
segments, not synthetic heights. The test streams it in irregular small chunks,
asserts 781 versus 783, and checks the reduced height. Separate mutations remove
an EOF, a segment RGT column, or the final byte and must publish no rows.
An EOF whose record framing is complete but whose payload is short must also fail.

## State transition

The rebuilt baseline and backfill scratch use `passKeyVersion: 2`. Old ATL13
scratch is rejected with an explicit reset instruction. Redis bookkeeping schema
2 ignores schema-1 pass histories, starting from the rebuilt committed baseline;
normal bounded discovery catches up from each preserved historical cursor.
Already published last-good data remains under the existing retention rules if
an upstream request fails. Filename RGT is retained transiently as `sourceRgt` on native rows;
persisted pass keys use segment RGT. Discovery groups overlapping acquisition
dates, including processed companions, and selects only the newest release per
orbit. Groups cover the existing +/- one-day attribution window and are fetched
within the existing per-product granule budget. Publication is atomic per UTC day:
a failed or deferred granule prevents replacement of every day it could contribute
to, while independent days remain publishable. A CMR listing failure defers the
reservoir entirely. An oversized group fails closed rather
than exceeding the budget or silently publishing a partial pass. Only actual failed requests spend a granule's three-attempt allowance;
successful and deadline-deferred resources never inherit a companion's failures.
Successful fetches are recorded individually, while missing companions are left
pending even if an older attempt had processed them. A newly listed member reopens
abandoned companions for another bounded retry cycle. A corrected release of a
failed orbit reloads its healthy processed companions and can complete the held
day. Retry discovery includes older failed dates even after another success
advances the cursor, so their companion listing remains complete.

The tuple's optional revision value sums the candidate orbit revisions for that
UTC day (granule acquisition date +/- one day). Updating any member or adding a late companion raises this value,
even when the maximum individual revision stays unchanged. This makes the new
complete reduction supersede old statistics regardless of segment count. A
persisted `refreshed` map records complete-day revision sums, including days with
no remaining passes. It prevents obsolete RGT keys and deleted observations from
resurrecting when baseline and cached state merge; the merge stays commutative
and idempotent. The
150-day processed-name retention exceeds the 120-day discovery lookback, so
companions cannot be pruned while their group is still eligible for refresh.
CMR listing includes four extra days for boundary companions; only the original
120-day window queues new work. Only individual days touching the incomplete
listing boundary are held; a chain of known companions cannot indefinitely defer
the pending days.
Regressions cover lower-than-maximum revision updates, late companions, failures,
midnight and discovery-window boundaries, obsolete/empty pass deletion, independent
days, retry recovery, atomic budget selection, and deadline deferral. The largest
atomic group across all 50 saved mission backfills contains two granules, within
both existing run budgets.

Deploy the code and baseline together. A rollback must restore both; schema-2
bookkeeping is incompatible with the old seeder and will be rebuilt by its
existing schema check. No Redis write, cron execution, deployment, or merge was
performed as part of the offline validation.

## Accuracy and cross-product identity

Lake Mead's 156 retained gauge matches have RMSE 0.051753 m before and 0.051750 m
after correction, after removing the median datum offset (0.045846 m in both).
Maximum absolute gauge residual remains 0.148508 m, below the existing 0.30 m
gate. The 0.10 m RMSE gate and despike thresholds are unchanged.

Matching the existing ATL06 fixture by UTC date + RGT now recovers every pair
previously matched only by time:

| Reservoir | Date + RGT pairs before | After | Offset-adjusted RMSE (m) after | Maximum residual (m) after |
| --- | ---: | ---: | ---: | ---: |
| Lake Mead | 71 | 156 | 0.020755 | 0.0680 |
| Tharthar | 23 | 92 | 0.017892 | 0.0615 |
| Atatürk | 48 | 98 | 0.020959 | 0.1020 |

The cross-check also independently pairs by time and asserts that every matched
RGT agrees. This fails on the old baseline and passes on the rebuilt histories.

Native float32 values retain more precision than CSV decimal strings. A separate
check of Tana granule `ATL13_20191007040827_01570501_007_01.h5` returned 15,330
source segments through both routes. Native reduction retained 15,178 segments
at 1788.172 m; CSV retained 15,177 at 1788.171 m. Reducing the native heights at
eight significant decimal digits reproduced the CSV statistics. Thus small
clipping-count and rounded-statistic differences can accompany the corrected
keys without changing a pass's quality decision. No height-reduction or despike
threshold was changed.

## Complete baseline rebuild

Rebuilt all 48 ATL13 histories from mission start through each entry's existing
acquisition cutoff, using three concurrent source workers. The two ATL06 histories
are unchanged, including their cursors and failure bookkeeping. This updates
identity at the existing cutoffs; it does not establish current source freshness.

All 3,922 passes remain (3,922 after), with 3,540 retained by the
existing quality/despike rules before and after. 2,872 pass keys change RGT. Every
overpass matches one-to-one by timestamp; every per-pass quality decision is
unchanged. Maximum level difference across all matched passes is 0.001 m;
maximum latest-retained-level difference per reservoir is 0.001 m. No granules
remain unresolved. Global and per-reservoir cutoffs are unchanged.

For reproduction, run the backfill per entry with `--until` set to the day after
its previous `processedThrough`, a new private `--scratch` directory, and the
committed watchlist. Assemble only after all ATL13 entries finish; retain the
existing ATL06 entries. The baseline's `passKeyVersion` must be 2.

The rekeyed column includes rejected passes as well as retained passes. Small
clipping-count differences described above do not alter these quality decisions.

| Reservoir | Passes before → after | Retained before → after | Rekeyed | Max level difference (m) |
| --- | ---: | ---: | ---: | ---: |
| gerd | 77 → 77 | 36 → 36 | 56 | 0.001 |
| nasser | 97 → 97 | 77 → 77 | 74 | 0.000 |
| merowe | 93 → 93 | 86 → 86 | 51 | 0.000 |
| roseires | 48 → 48 | 45 → 45 | 30 | 0.000 |
| tana | 108 → 108 | 100 → 100 | 108 | 0.001 |
| victoria | 87 → 87 | 82 → 82 | 76 | 0.001 |
| ataturk | 102 → 102 | 100 → 100 | 52 | 0.001 |
| keban | 93 → 93 | 91 → 91 | 53 | 0.001 |
| ilisu | 92 → 92 | 77 → 77 | 70 | 0.001 |
| assad-tabqa | 102 → 102 | 101 → 101 | 81 | 0.001 |
| tishrin | 87 → 87 | 82 → 82 | 87 | 0.001 |
| mosul | 67 → 67 | 64 → 64 | 67 | 0.000 |
| haditha | 81 → 81 | 66 → 66 | 63 | 0.000 |
| tharthar | 117 → 117 | 111 → 111 | 88 | 0.000 |
| dukan | 47 → 47 | 44 → 44 | 47 | 0.000 |
| darbandikhan (ATL06) | 52 → 52 | 44 → 44 | 0 | 0.000 |
| karkheh | 62 → 62 | 61 → 61 | 38 | 0.000 |
| urmia | 87 → 87 | 71 → 71 | 78 | 0.001 |
| toktogul | 64 → 64 | 53 → 53 | 64 | 0.001 |
| nurek | 61 → 61 | 46 → 46 | 43 | 0.001 |
| tarbela | 62 → 62 | 44 → 44 | 11 | 0.000 |
| mangla | 55 → 55 | 49 → 49 | 48 | 0.000 |
| bhakra | 69 → 69 | 61 → 61 | 69 | 0.001 |
| caspian | 85 → 85 | 78 → 78 | 48 | 0.000 |
| three-gorges | 53 → 53 | 51 → 51 | 42 | 0.000 |
| xiaowan | 67 → 67 | 59 → 59 | 67 | 0.001 |
| nuozhadu | 68 → 68 | 60 → 60 | 33 | 0.001 |
| tonle-sap | 92 → 92 | 89 → 89 | 92 | 0.000 |
| nam-ngum | 61 → 61 | 57 → 57 | 54 | 0.000 |
| kariba | 106 → 106 | 104 → 104 | 81 | 0.000 |
| cahora-bassa | 91 → 91 | 87 → 87 | 46 | 0.001 |
| volta | 76 → 76 | 71 → 71 | 51 | 0.000 |
| kainji | 57 → 57 | 40 → 40 | 52 | 0.000 |
| chad | 80 → 80 | 65 → 65 | 80 | 0.000 |
| turkana | 109 → 109 | 104 → 104 | 89 | 0.000 |
| gibe-iii (ATL06) | 60 → 60 | 60 → 60 | 0 | 0.000 |
| gatun | 66 → 66 | 51 → 51 | 48 | 0.000 |
| mead | 176 → 176 | 156 → 156 | 90 | 0.001 |
| powell | 78 → 78 | 72 → 72 | 27 | 0.001 |
| guri | 101 → 101 | 97 → 97 | 77 | 0.001 |
| itaipu | 54 → 54 | 51 → 51 | 34 | 0.001 |
| furnas | 89 → 89 | 87 → 87 | 64 | 0.000 |
| sobradinho | 104 → 104 | 102 → 102 | 102 | 0.000 |
| kakhovka | 47 → 47 | 32 → 32 | 45 | 0.000 |
| kremenchuk | 57 → 57 | 56 → 56 | 24 | 0.000 |
| dnipro | 60 → 60 | 55 → 55 | 23 | 0.000 |
| mingachevir | 94 → 94 | 92 → 92 | 72 | 0.000 |
| sevan | 91 → 91 | 89 → 89 | 87 | 0.001 |
| galilee | 43 → 43 | 42 → 42 | 43 | 0.000 |
| dead-sea | 47 → 47 | 42 → 42 | 47 | 0.000 |
