# Natural-event source recovery

## Problem

PRs #8270 and #8271 repaired GDACS request fan-out and partial-run publication. They did not preserve failed sources across runs. On September 17, EONET failed and the canonical feed fell from 16 records to five GDACS records; metadata named only the GDACS volcano failure. The volcano MAP request returns 404 even though SEARCH returns a valid volcano collection.

Goal: a failed EONET or GDACS type request must not remove usable last-good records or renew their success time. Healthy companions must still update. Valid empty responses must remove obsolete records. Missing, malformed and expired coverage must remain explicit failures.

## Grounded model

- **Overview:** `runSeed` acquires `seed-lock:natural:events`, then fetches sources, transforms/deduplicates them, publishes Redis data, and writes health metadata. The standalone worker and climate bundle share this lock.
- **Key concepts:** a successful observation (including zero records) differs from a failed attempt. Source snapshots precede deduplication and the 100-event GDACS display cap. The aggregate publication time is not every source's success time.
- **How it works:** NHC already has a validated nine-hour snapshot and bounded failure policy. EONET rejection becomes `[]`; GDACS retains only this run's successful types. Recovery state must be read inside the existing lock and written before canonical replacement. Strict Redis read/write errors must not become cache misses.
- **Where:** keep ownership in `scripts/seed-natural-events.mjs`. The natural-events RPC reads the canonical payload and its `fetchedAt`; health reads `seed-meta:natural:events`. Western-Pacific cyclones require the uncapped TC source, not the general feed's cap.
- **Gotchas:** never reconstruct complete source coverage from the lossy canonical aggregate. Retaining zero is valid only with a prior validated success. Redis TTL extension must not extend an absolute source deadline.

## Usage (caller's view)

```js
// Seeder: source state is private; consumers keep their existing call.
const previousSources = await readSeedSnapshot(SOURCE_SNAPSHOT_KEY, { strict: true });
const data = await fetchNaturalEvents({ previousSources, previousNhcSnapshot });
// runSeed's beforePublish persists data._sourceSnapshots before replacing data.
const publicData = naturalEventsPublishTransform(data);
const { freshnessMetaPatch } = naturalEventsAfterPublish(data);
// publicData.fetchedAt is conservative when retained sources are present.
// freshnessMetaPatch.sourceHealth names each source's state and original clock.
```

## Shape

```js
// Private source ID: eonet | gdacs:EQ | gdacs:FL | gdacs:TC | gdacs:VO | gdacs:WF | gdacs:DR
// Snapshot: { version: 1, fetchedAt: number, retainedUntil: number, records: array }
// Selection: Snapshot | null; diagnostics derive status from this and the fetch result.
function selectSourceSnapshot(result, previous, now, validateRecords) { throw new Error('not implemented'); }
async function fetchGdacs(fetchFn, { previousSources, now }) { throw new Error('not implemented'); }
async function fetchNaturalEvents({ previousSources, previousNhcSnapshot, now, fetchFn }) { throw new Error('not implemented'); }
```

One private Redis key stores EONET's normalized records and each GDACS type's validated raw features. Keeping raw GDACS features private preserves severity ranking without adding transport fields to public events. A source-specific boundary validator runs before success is accepted and before retained state is reused (boundary discipline). Successful responses replace snapshots, including empty arrays. Failures retain only validated snapshots younger than the existing 540-minute natural-event budget; neither clock nor deadline advances. Diagnostics distinguish retained from unavailable and preserve every failed source, including concurrent NHC failures. No new public method, shared framework, lock or scheduler is required.

Use the documented GDACS SEARCH route for VO with the same 30-day horizon as the natural-event feed. Keep MAP for the other five types. SEARCH is a recent-event query, not proof of active volcano status: map its validated `iscurrent` value to `closed`, and reject missing or malformed state into bounded retention. Request 100 entries; reject a full page rather than claim truncated coverage. Keep the existing non-Green filter. Official evidence: [GDACS API schema](https://www.gdacs.org/gdacsapi/swagger/v1/swagger.json); [September 17 volcano query](https://www.gdacs.org/gdacsapi/api/Events/geteventlist/SEARCH?eventlist=VO&fromDate=2026-08-18&toDate=2026-09-17&pageSize=100&pageNumber=1) returned one Orange Point feature, event 1000148, with `iscurrent: "false"`. MAP VO returned 404; a failed request is never reclassified as valid empty.

## Synthesis decision

The repository requires sequential agent work, so these are two sequential whole-design sketches, not independent model reviews. Rubric: preserve source truth, allow companion updates, keep caller surface small, bound persistence, and fit existing publication. Scores are 0–2 per criterion.

| Candidate | Truth | Updates | Surface | Bounds | Integration | Total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| A: retain the entire canonical aggregate on any failed request | 1 | 0 | 2 | 1 | 2 | 6 |
| B: retain source observations before aggregate construction | 2 | 2 | 2 | 2 | 2 | 10 |

B is the base. It hides retention inside the existing producer. A's existing `runSeed` fail-closed publication hooks are reused; its whole-aggregate rollback policy is rejected because it blocks healthy updates and cannot recover records lost to a prior cap or deduplication. Red-flag screen: no pass-through module, caller-owned retention policy, temporal helper layer or new public abstraction. The selector owns validation and bounded reuse as one decision.

## Tradeoffs accepted

- We accept one private snapshot key and its writes in exchange for complete pre-merge source retention.
- We accept a conservative aggregate `fetchedAt` in exchange for not presenting retained observations as a fresh full-source fetch. Per-source clocks remain in metadata.
- We accept a cold-start gap until each source succeeds; the old aggregate cannot establish complete source coverage.
- We accept failing a full volcano search page in exchange for a fixed request budget and no silently truncated success.

## Alternatives considered

A's caller sketch is `if (results.some(failed)) return null; else return aggregate(results)`. Its signature is `buildCompleteAggregate(results): Aggregate | null`, with a not-implemented body in the candidate sketch. It hides less: the caller must choose between blocking every healthy update or dropping failed coverage. Reusing the canonical feed as a source snapshot also loses hidden, capped and deduplicated records, so neither variant meets the acceptance criteria.

## Open questions and risks

Will the volcano SEARCH contract remain stable, and will the new deployment observe a valid success for each source? Verify natural runs after deployment. Are all-source failures visible while aggregate data remains? Keep existing health containment and NHC policies unchanged; test source diagnostics rather than relax thresholds.

Non-goals: seeder cadence, health budgets/grace, HKO recovery redesign, production mutations, and automatic merge/deployment.

## Next implementation step

Add failing tests for the live volcano request contract and success → failure → recovery/expiry transitions, then fill in the selected sketch and verify real Redis publication and RPC consumption with fixtures.
