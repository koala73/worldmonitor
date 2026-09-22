# Confirmed empty infrastructure results and stale client caches

Issue: #7870. Audit date: 2026-09-08.

## Contract

The DDoS and traffic-anomaly RPCs return HTTP 200 only after reading a valid
companion payload. Empty arrays are valid, including a country filter with no
matches. Missing keys, missing Redis configuration, read errors, invalid JSON,
and invalid payload shapes return HTTP 503 through the existing error mapper.
No protobuf change is needed. The generated client rejects the failed response,
so the real circuit breaker retains its last successful result.

The infrastructure client caches valid empty responses, including country-filtered
traffic results. DDoS hydration already has a presence/shape guard on main; the
existing hydration tests verify that an empty payload replaces a non-empty cache
without an RPC request.

After the 30-minute client TTL expires, the first read can serve the old value
while the background refresh runs. Subsequent reads use the confirmed empty
result. Failed refreshes retain last-good, including a previously confirmed empty
result. This change does not alter the shared breaker's retention policy.

## Audit of the other named breakers

All four have the same mechanical exposure: their `shouldCache` predicate accepts
the old non-empty entry and rejects a new empty result, without refresh eviction.
Their domain contracts differ:

| Client | Affected behavior | Current producer/reader contract |
| --- | --- | --- |
| `src/services/cross-source-signals.ts` | Confirmed-empty bug is present. Old signals can remain after all signals clear. | `scripts/seed-cross-source-signals.mjs` explicitly publishes empty signals as a valid no-escalation result. The RPC also collapses missing/unreadable data to empty. It needs a success/failure distinction before changing the predicate. |
| `src/services/cable-health.ts` | Confirmed-empty bug is present. Old cable evidence can remain after signals expire. | `get-cable-health.ts` can successfully compute an empty map; it also returns an empty map when no usable fallback remains after failure. Its one-minute local cache adds another delay. It needs an availability contract before changing the predicate. |
| `src/services/cached-theater-posture.ts` | Stale retention on empty is present; a healthy-empty publication path is not established. | `get-theater-posture.ts` rejects empty live/stale/backup snapshots and returns a no-store empty fallback. Client retention preserves last-good, but can hide unavailable data. A blanket eviction change would change failure behavior. |
| `src/services/cached-risk-scores.ts` | The predicate has the same exposure, but a normal global confirmed-empty result is not established. | The client requests the global dataset. `get-risk-scores.ts` computes country scores even on its final degraded fallback. Region-filtered empty responses are not used by this client. Cached empty/corrupt payloads can still exercise the mechanism. |

The latter four services are audited here only. Their domain-specific repairs are
outside the two companion RPCs covered by this issue.

## Verification

`tests/infrastructure-companion-cache.test.mts` drives the real infrastructure
service, circuit breaker, generated HTTP client and router, error mapper, and
Redis reader. Only Redis HTTP and time are controlled. It covers non-empty to
empty replacement, read failures before and after empty publication, missing
keys/configuration, malformed data, recovery, seed envelopes, and country filters.
The initial regression failed because all three read paths returned 200 on Redis
failure instead of 503.

`tests/bootstrap-hydration-reuse.test.mts` verifies confirmed-empty hydration and
country cache reuse. `tests/cloudflare-radar-companion-publication.test.mjs`
retains the existing real seeder-to-RPC proof. Run them with:

```sh
node --import tsx --test tests/infrastructure-companion-cache.test.mts tests/bootstrap-hydration-reuse.test.mts tests/cloudflare-radar-companion-publication.test.mjs
npm run typecheck
npm run typecheck:api
npm run lint:boundaries
```

These checks do not prove deployed Edge behavior, live Cloudflare freshness, or
rendered dashboard behavior. After authorized deployment, observe both companion
RPCs through an empty publication and a read-failure/recovery window. Confirm
200/empty replaces an old summary and 503 preserves last-good. Search server logs
for `DDoS summary cache unavailable` and `Traffic anomalies cache unavailable`;
sustained 503s while valid seed keys exist require investigation.
