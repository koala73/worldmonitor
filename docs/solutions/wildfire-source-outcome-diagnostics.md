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
