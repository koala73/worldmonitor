# Wildfire source diagnostic records

The wildfire seeder emits `wildfire_source_outcome` when each FIRMS, CWFIS, or BC acquisition settles. A settled acquisition can return fresh data, partial data, retained data, or fail. Each fetch attempt produces up to three records. A killed process or fetch deadline can prevent a source from settling.

These records describe acquisition before validation and publication. They do not confirm Redis writes, physical key expiry, stored-payload parity, or consumer freshness. A rejected source emits its record before the merge handles the rejection. A fully rejected run can therefore have source records without a successful publication.

## Source fields

| Field | Meaning |
| --- | --- |
| `runId` | The same generated identifier printed by `runSeed`. Whole-fetch retries share it. |
| `deploymentId`, `commitSha` | Railway environment values accepted only as a UUID and a full 40-character hexadecimal commit. Missing or malformed values are `null`. These values identify the declared deployment and do not attest its contents. |
| `source` | `firms`, `cwfis`, or `bc`. |
| `outcome` | `fresh`, `partial`, `retained`, or `failed`. Retained includes a valid last-good empty snapshot. |
| `recordCount` | Number of rows returned by the adapter before merging, deduplication, or publication limits. A rejection has unknown count, represented by `null`. An exhausted FIRMS adapter returns a known empty array. |
| `retainedRecordCount` | Rows in the retained recovery snapshot. This can differ from current returned rows for partial CWFIS data. Unknown snapshot state is `null`. FIRMS has no source recovery snapshot and reports zero. |
| `fetchedAt` | Adapter snapshot clock for the returned complete or retained source cohort. FIRMS and current partial CWFIS data have no complete source clock and report `null`. This is not a provider observation timestamp. |
| `lastAttemptAt` | Adapter attempt clock, or the acquisition wrapper start when no snapshot exists. A failed snapshot read can prevent a provider request. |
| `retainedFetchedAt` | Original clock of an old recovery snapshot, including when current CWFIS data is partial. Otherwise `null`. |
| `retainedUntil` | Logical snapshot reuse deadline. BC uses its original snapshot clock plus two hours. CWFIS uses its original snapshot clock plus three hours. Missing or rejected snapshots report `null`. This is not a physical Redis expiry. |
| `route` | Successful current acquisition route, `area`, `wfs`, or `kml`. Retained or failed acquisition reports `null`. |

Partial CWFIS means the active layer succeeded while the prescribed layer failed. Its current rows are distinct from the retained recovery snapshot. A retained BC or CWFIS event keeps the old snapshot clock. Neither publication nor diagnostics moves that clock or extends its logical deadline.

## FIRMS failed attempts

`firms_attempt_failure` records each failed request or body-read attempt, including the final attempt. It includes run and deployment context, an allowlisted satellite and region, a one-based attempt number, `request` or `body` phase, and elapsed `durationMs` from the monotonic clock. Duration excludes retry sleep. Valid HTTP status codes are retained; absent codes are `null`. `timeout` reports a top-level `TimeoutError` or `AbortError`; transport timeout codes remain in the transport entries.

The transport scanner visits at most 16 error nodes and eight children per aggregate. It emits at most eight entries. Each entry keeps the allowlisted code, syscall, and explicit address family from the same error node. Unknown fields are `null`. The scanner does not infer a family from an IP address or infer a failure stage from a code.

Raw addresses, URLs, credentials, response bodies, messages, stacks, and arbitrary error codes are excluded. Diagnostic logger failures do not replace source results or change retry decisions. The existing request count, pacing, timeout, validation, retention, and storage behavior is unchanged.

## CWFIS outage and fallback assessment, 2026-11-11

The active and prescribed WFS layers returned HTTP 500 with `OperationProcessingFailed` and `Error occurred getting features`. Railway retries received the same response as direct requests. This establishes a provider request failure, but not its internal database cause.

The stored source snapshot last succeeded at 08:10:39 UTC. Its first failure was at 08:20:51 UTC and its retention deadline was 11:10:39 UTC. The 08:55 publication retained 130 CWFIS rows, including 105 active fires and 25 prescribed burns. Its compact dashboard payload included 50 CWFIS rows. FIRMS completed all 27 requests, and BC acquisition succeeded. The warning after the third failed run therefore did not establish that Canadian records were absent.

The reported-fires layer was available at `https://geoserver.cwfif.nrcan.gc.ca/geoserver/ows`. The existing `record_end >= now` filter alone returned 5,594 matched records, including extinguished fires. This layer cannot replace the active layer without an additional filter.

A bounded WFS 2.0 `GetFeature` probe at 09:03:47 UTC used `typeNames=public:cwfif_national_reportedfires`, `count=1000`, `startIndex=0`, `sortBy=id`, and `outputFormat=application/json`, with this candidate CQL filter:

```text
record_end >= 2026-11-11T09:03:47Z
AND stage_of_control_status IN ('OC','BH','UC')
AND fire_was_prescribed <> 1
```

The response returned all 105 matched rows. Their national fire IDs exactly matched the 105 active IDs in the 08:10 snapshot. An earlier filter with `fire_was_prescribed = 0` returned only 99 rows. The six omitted fires had `fire_was_prescribed = -1`, including four out-of-control fires in the Northwest Territories. An unknown prescribed flag is not equivalent to a prescribed burn in the current normalizer.

This is historical ID parity, not proof of a current replacement feed. The active layer still returned HTTP 500 at 09:01:57 UTC, so a simultaneous comparison was unavailable. No fallback is enabled by this assessment. Acceptance requires provider-backed status semantics, simultaneous complete active-layer and candidate results, field parity after normalization, and evidence for prescribed-fire coverage. Any later fallback must preserve the existing response-size, pagination, timeout, retry, source-clock, and retention limits. A successful filtered active query alone must not mark both Canadian layers recovered.
