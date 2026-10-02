---
title: A seed-meta override that equals the data key clobbers the seed on every write
date: 2026-09-20
category: logic-errors
module: scripts/_seed-utils.mjs
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "get-bls-series served an empty 200 body for 6 months while /api/health reported HEALTHY; after PR #8360 replaced the handler's swallow-all catch with readRequiredSeed, every dashboard load returned 503 (Sentry WORLDMONITOR-145, about 16,500 origin 503s in 14 h)"
  - "The per-series key bls:series:USPRIV held a 44-byte {fetchedAt, recordCount} seed-meta record on a 7-day TTL instead of the seeder's 72 h series payload"
  - "Every 200 for the route in 14 days of Axiom retention had res_bytes = 2, an empty JSON object"
  - "The canonical bls:series:v1 envelope and seed-meta:economic:bls-series were correct throughout, so the health probe had nothing to report"
root_cause: logic_error
resolution_type: code_fix
related_components: [database, testing_framework]
tags: [seed-meta, extra-keys, self-clobber, health-blind-spot, upstash, ttl-mismatch, bls-series, res-bytes-audit]
---

# A seed-meta override that equals the data key clobbers the seed on every write

## Problem

`scripts/seed-bls-series.mjs` (a Railway seeder in the `seed-bundle-macro` bundle) published a per-series extra key for each BLS series and passed its own data key as the seed-meta override:

```js
// pre-fix scripts/seed-bls-series.mjs afterPublish
await writeExtraKeyWithMeta(key, value, CACHE_TTL, count, `bls:series:${seriesId}`);
//                          ^ key === `bls:series:${seriesId}`     ^ same string
```

`writeExtraKeyWithMeta` forwarded the override to `writeSeedMeta`, which used it verbatim as the meta key. Before the fix the resolution was a bare fallback, so any truthy override won without a shape check:

```js
// pre-fix scripts/_seed-utils.mjs writeSeedMeta
const metaKey = metaKeyOverride || `seed-meta:${dataKey.replace(/:v\d+$/, '')}`;
``` Every daily run therefore wrote the series payload to `bls:series:USPRIV` and then immediately overwrote the same key with the 44-byte `{fetchedAt, recordCount}` heartbeat on the 7-day seed-meta TTL, while the seeder's declared data TTL for that key was 72 h (`CACHE_TTL = 259200` in `scripts/seed-bls-series.mjs`).

`api/health.js` never watched the clobbered key. Its freshness table (`SEED_META` in `api/health.js`) grades the canonical envelope (`blsSeries: 'bls:series:v1'`, `api/health.js:271`) and the seed-meta record `runSeed` writes correctly for that canonical key (`seed-meta:economic:bls-series`, `api/health.js:1188`). Both were written on schedule, so health read HEALTHY continuously from 2026-03-23 (the date `git blame` puts on the seeder line) until 2026-09-20.

`server/worldmonitor/economic/v1/get-bls-series.ts` read the per-series key, the one being clobbered, inside a swallow-all `try/catch` that degraded any failure to an empty `200`. PR #8360 replaced that swallow with `readRequiredSeed` (503 on a cache miss or an undecodable value); 13 minutes after its deploy a 503 storm began on every dashboard load that requested a BLS series (Sentry WORLDMONITOR-145). Axiom supplied the honest picture: about 16,500 origin 503s in the following 14 h, and every prior `200` for the route in the preceding 14 days had `res_bytes = 2`, an empty `{}`. #8360 did not introduce the bug; it stopped hiding it.

## Symptoms

- Sentry issue WORLDMONITOR-145: a 503 spike starting about 13 minutes after the #8360 deploy. Sentry's own count (696 events) understated the origin volume by roughly 24x; Axiom `wm_api_usage` showed about 16,500 in 14 h.
- Axiom `res_bytes` on the route: every `200` in the 14 days before the spike carried `res_bytes = 2`, a success status over an empty payload.
- Public `/api/health?compact=1` reported HEALTHY throughout, because it grades only `bls:series:v1` and `seed-meta:economic:bls-series`, neither of which the bug touched.
- A read-only Upstash REST peek at the exact key the RPC read (`bls:series:USPRIV`): `TYPE` string, `GET` shape `{"fetchedAt": ..., "recordCount": 1}` (the heartbeat, not the series), `TTL` about 6.8 days. The seeder's declared data TTL is 72 h. The wrong TTL alone was the tell that a meta write had landed on the data key.

## What Didn't Work

- **The public health check.** `/api/health?compact=1` said HEALTHY and stayed that way. It grades the canonical key and its seed-meta record, never the per-series keys the RPC actually read. Trusting it would have closed the investigation with the wrong answer.
- **The Railway deployment list for the bundle.** It showed only `SKIPPED` cron ticks with empty logs, which looked like the seeder was not running at all. A cron tick re-runs the active deployment rather than creating its own; the real logs live under the active deployment id from `railway status --json`, not under the tick's record.
- **Sentry's event count as the incident denominator.** 696 events versus about 16,500 origin 503s; Axiom's raw request log was needed to size the blast radius.
- **Direct curl reproduction.** The API blocks default curl user agents (`agent_request_blocked`) and the full `/api/health` requires an operator key, so a naive probe either got blocked or returned the gated summary rather than per-key detail.
- **Guarding "fresh clock, stale payload" alone.** (session history) The write-then-meta ordering of `writeExtraKeyWithMeta` was chosen over an atomic `multi-exec` path during the #7845 Cloudflare Radar fix precisely because it can never advance the seed-meta clock over an old payload. That reasoning holds only while the meta record and the payload live at different keys; a colliding override turns the same ordering into "fresh clock, erased payload."

## Solution

**The diagnostic step that settled it:** a read-only Upstash REST peek (`EXISTS` / `TTL` / `TYPE` / `GET`) at the exact key the RPC reads, `bls:series:USPRIV`, rather than at the canonical key health watches. The value was a 44-byte meta record, not a series payload, and its TTL (about 6.8 days) did not match the seeder's declared data TTL (72 h). That shape and TTL mismatch pointed straight at `writeSeedMeta`; reading it showed the override was used verbatim with no distinctness check, and `git blame` dated the seeder's colliding call to 2026-03-23.

The fix ships in 3 files (branch `fix/seed-bls-series-meta-clobber`, PR #8425, closes issue #8424; open and unmerged as of this writing).

**1. `server/worldmonitor/economic/v1/get-bls-series.ts`** reads only the canonical envelope through `readRequiredSeed` and selects the requested series from it:

```ts
const BLS_CANONICAL_KEY = 'bls:series:v1';

const seeded = await readRequiredSeed(BLS_CANONICAL_KEY, value => {
  const data = value as { series?: unknown } | null;
  return Array.isArray(data?.series) ? (data.series as unknown[]) : undefined;
});
const series = seeded.find(
  (entry): entry is BlsSeries => isServableSeries(entry) && entry.seriesId === req.seriesId,
);
if (!series) {
  throw new SeedUnavailableError(`${BLS_CANONICAL_KEY} series ${req.seriesId}`);
}
```

`readCachedJsonInternal` (`server/_shared/redis.ts:75-111`) unwraps the `runSeed` contract envelope (`unwrapEnvelope(parsed).data`), so this reads the same `{series: [...]}` shape whether or not the writer is in envelope mode. A known series id absent from an otherwise valid envelope throws `SeedUnavailableError` naming the series (`server/_shared/required-seed.ts`), instead of a message that blames the healthy canonical key.

`isServableSeries` is the same predicate the seeder's `validate()` applies before publishing — `seriesId`, `title` and `units` present as strings, and at least 1 observation. The two are written to be identical on purpose: a reader stricter than its producer turns a publishable seed into a 503, and a producer stricter than its reader wastes a cycle refusing data the reader would have served. Without it the decoder would cast whatever the envelope held and serve a 200 whose body is missing fields the proto marks required, which is the same empty-success failure this whole incident is about, one layer down. The check is per entry, so a malformed series does not take its healthy siblings in the same envelope down with it.

**2. `scripts/seed-bls-series.mjs`** drops the per-series extra-key machinery entirely. `perKeySeries`, `publishTransform` and `afterPublish` are gone; the canonical `bls:series:v1` envelope is the seeder's only write:

```diff
- import { loadEnvFile, runSeed, writeExtraKeyWithMeta, sleep, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
+ import { loadEnvFile, runSeed, sleep, resolveProxyForConnect, fredFetchJson } from './_seed-utils.mjs';
  ...
- const series = { seriesId: def.id, title: def.title, units: def.units, observations: result.observations };
- all.push(series);
- perKeySeries[`${KEY_PREFIX}:${def.id}`] = { series };
+ all.push({ seriesId: def.id, title: def.title, units: def.units, observations: result.observations });
```

`validate()` was `Array.isArray(data?.series) && data.series.length > 0`, which accepted a 1-of-2 fetch. It now requires every configured `FRED_SERIES` id to be present in the shape the reader will serve:

```js
// Deliberately identical to isServableSeries in the RPC handler.
function isPublishableSeries(s) {
  return typeof s?.seriesId === 'string'
    && typeof s.title === 'string'
    && typeof s.units === 'string'
    && Array.isArray(s.observations)
    && s.observations.length > 0;
}

export function validate(data) {
  if (!Array.isArray(data?.series)) return false;
  return FRED_SERIES.every((def) =>
    data.series.some((s) => isPublishableSeries(s) && s.seriesId === def.id),
  );
}
```

A partial cohort now fails validation, which routes `runSeed` into its validation-skip path: the last-good envelope keeps serving both series and `STALE_SEED` fires if the outage persists, instead of publishing an envelope missing 1 series and serving that series a 503 all day. `BLS_SERIES_IDS` (`FRED_SERIES.map(def => def.id)`) is exported and pinned equal to `economicBlsSeriesIds` in `shared/openapi-filter-param-contracts.json`, closing the drift path where the RPC's accepted ids and the seeder's published ids could silently diverge.

**3. `scripts/_seed-utils.mjs`** adds the actual guard, `resolveSeedMetaKey(dataKey, metaKeyOverride)` (`scripts/_seed-utils.mjs:1106-1117`):

```js
export function resolveSeedMetaKey(dataKey, metaKeyOverride) {
  if (metaKeyOverride === undefined || metaKeyOverride === null || metaKeyOverride === '') {
    return `${SEED_META_KEY_PREFIX}${dataKey.replace(/:v\d+$/, '')}`;
  }
  if (typeof metaKeyOverride !== 'string' || !metaKeyOverride.startsWith(SEED_META_KEY_PREFIX) || metaKeyOverride === dataKey) {
    throw new Error(
      `seed-meta key for ${dataKey} must be a distinct ${SEED_META_KEY_PREFIX}* key, got ${String(metaKeyOverride)} `
      + '(a colliding override overwrites the data it describes, #8424)',
    );
  }
  return metaKeyOverride;
}
```

With no override it derives `seed-meta:<dataKey minus a trailing :vN>`; with an override it requires a string that starts with `SEED_META_KEY_PREFIX` (`'seed-meta:'`) and differs from `dataKey`, throwing otherwise. Every path that resolves a seed-meta key now calls it:

- `writeSeedMeta(dataKey, recordCount, metaKeyOverride, ...)` (`scripts/_seed-utils.mjs:1135-1157`) resolves before building or sending the `SET`.
- `writeExtraKeyWithMeta(key, data, ttl, recordCount, metaKeyOverride, ...)` (`scripts/_seed-utils.mjs:1159-1171`) resolves before `writeExtraKey(key, data, ttl)`, so a colliding pair fails before the data write too and the previous value stays intact.
- `writeExtraKeyWithMetaAtomically({ key, metaKey, ... })` (`scripts/_seed-utils.mjs:1176-1243`) resolves before the `multi-exec` transaction is built.
- A config-time loop inside `runSeed` over `extraKeys[].metaKey` (`scripts/_seed-utils.mjs:2365-2373`):

```js
for (const ek of Array.isArray(extraKeys) ? extraKeys : []) {
  if (ek?.metaKey === undefined || ek?.metaKey === null) continue;
  try {
    resolveSeedMetaKey(ek.key, ek.metaKey);
  } catch (err) {
    console.error(`  CONTRACT VIOLATION: ${domain}:${resource} ${err.message}`);
    process.exit(1);
  }
}
```

This loop covers the `extraKeys` configuration path only, and it runs before any provider fetch, so a colliding `extraKeys[].metaKey` exits 1 with 0 upstream calls spent and 0 writes made. The BLS shape — a direct `writeExtraKeyWithMeta` call inside `afterPublish` — is caught by the helper guard above instead: still before its own data write, so the previous value survives, but only after the provider work and the canonical publish have already run.

**Tests** (13 of 13 pass at the current tree):

- `tests/seed-utils-meta-key-guard.test.mjs` reproduces the exact shipped call shape (`writeExtraKeyWithMeta('bls:series:USPRIV', payload, 259200, 1, 'bls:series:USPRIV')`) and asserts it rejects with 0 writes (`sets.length === 0`); covers `writeSeedMeta`, `writeExtraKeyWithMetaAtomically`, `resolveSeedMetaKey`'s derive/accept/reject matrix (including the case where the override is namespaced yet still equals the data key), and the `runSeed` config-time exit-1-before-fetch path.
- `tests/seed-bls-series-validate.test.mjs` asserts `validate()` accepts the full cohort, refuses a 1-of-2 fetch and a zero-observation series, and asserts `BLS_SERIES_IDS` equals `economicBlsSeriesIds` from the shared contract file.
- The BLS block in `tests/seed-unavailable-cache.test.mts` exercises the RPC end to end against a mocked cache: the canonical read sliced to `limit`, the `runSeed` envelope unwrap, a regression case seeding `bls:series:USPRIV` with the exact clobbered heartbeat shape and asserting the RPC ignores it, the missing-series 503 naming the series, 4 malformed-entry cases (missing `title`/`units`, a non-string `title`, a non-string `units`, zero observations) each asserting the sibling series still serves, and the 6 required-seed failure modes.

## Why This Works

The root defect was that `writeSeedMeta` treated `metaKeyOverride` as trusted input with no shape check: any string, including the data key itself, was accepted and used as a Redis key to `SET` into. That made "pass the wrong string" a silent, self-inflicted data-loss bug rather than a loud, config-time error. `resolveSeedMetaKey` turns the implicit invariant ("a meta key must never be the data key it describes, and must live in `seed-meta:`") into an explicit, enforced one, checked at every call site that can reach a Redis write, including the derive-with-no-override default path, so legitimate callers get identical behavior to before.

Placing the check at the top of `writeExtraKeyWithMeta`, `writeExtraKeyWithMetaAtomically` and `writeSeedMeta`, before any `fetch` to Upstash, means a violation fails closed: the previous good value survives, rather than the old behavior where the data write succeeded and only the subsequent meta write clobbered it. The `runSeed` config-time loop over `extraKeys[]` moves the failure earlier still, before the seeder calls its upstream provider, so a future seeder shipping this pattern in its `extraKeys` config (rather than through a raw `writeExtraKeyWithMeta` call, as BLS did) is caught with 0 provider calls and 0 writes.

Separately, `validate()` moving from "at least 1 series present" to "every configured series present with observations" closes the failure mode that would have made #8360's correct 503 land as an incident on the next flaky FRED day: a partial upstream fetch used to still count as a publishable seed, so the RPC's known-but-absent series case could be reached by ordinary upstream flakiness, not only by the meta clobber. Now a partial fetch takes `runSeed`'s existing validation-skip branch, which preserves the last-good envelope and lets `STALE_SEED`, a slower and already-monitored health signal, take over instead of a per-series 503.

## Prevention

- **The guard invariant, stated once and enforced everywhere.** A seed-meta key is either omitted (derived) or a distinct string in the `seed-meta:` namespace, never the data key it annotates. Any function that accepts a `metaKey` or `metaKeyOverride` parameter routes it through `resolveSeedMetaKey` before doing anything with it, including config-time validation in `runSeed`'s `extraKeys` loop, not just the write-time call sites.
- **When a "healthy" seed's RPC serves empty or wrong data, peek the exact key the reader reads, not the key health watches.** A canonical key and a per-item key drift independently; the health freshness table (`SEED_META` in `api/health.js`) is a curated subset, and a per-item key added to a seeder is not automatically added to it. `EXISTS` / `TYPE` / `TTL` / `GET` on the actual read path is the fastest way to see the real shape.
- **A TTL mismatch is a strong tell of a meta-on-data collision.** If a key's TTL does not match its owning seeder's declared data TTL, something else with a different TTL policy (here the 7-day seed-meta floor) wrote to it last. (session history) The seed-meta TTL rule is `max(floor, dataTtl)` in `resolveSeedMetaTtl`, not the floor itself, so check the relationship against that function rather than restating it from memory.
- **A required-seed reader accepts only what its producer is allowed to publish, and the two predicates are one contract.** Decoding an envelope with a cast rather than a shape check reintroduces the empty-success failure one layer down: the read succeeds, the entry is short a required field, and the endpoint answers 200 with a body that does not satisfy its own schema. Write the reader's predicate and the producer's validation as the same rule and say so in both comments, because they fail in opposite directions — a reader stricter than its producer 503s a seed that was legitimately published, and a producer stricter than its reader burns a cycle refusing data the reader would have served. Check per item, so a single malformed entry does not fail its healthy siblings.
- **Health must watch the same key the RPC reads, or it proves nothing about that RPC.** Adding a per-item extra key to a seeder comes with either folding that data into the canonical envelope the RPC and health both trust (the approach taken here) or adding the new key to health's watch list explicitly. The canonical key's freshness never implies a sibling extra key's freshness.
- **Sentry event counts understate origin volume; get the denominator from the raw request log.** Count actual requests and responses for the affected route in Axiom before sizing an incident. `res_bytes` on prior `200`s is a cheap secondary signal: a long run of `res_bytes = 2` on a "successful" endpoint is evidence the bug predates whatever change first surfaced it as an error.
- **Test shape for this class of bug.** (1) A writer-refuses-collision test that reproduces the exact shipped call shape and asserts the write is refused and that 0 write calls were made, not just that the call threw; a test that only checks "it throws" passes even if the data write happened before the throw. (2) A `runSeed`-exits-1-before-fetch test for the config-time path, asserting the provider function's call count is 0 and no `SET` was issued. (3) An RPC-level regression test that seeds the cache with the exact clobbered shape production held (the heartbeat under the per-item key) and asserts the RPC does not read it. (4) Where a guard has several OR'd clauses, at least 1 input that fails only the clause carrying the headline invariant (an override that is namespaced yet equals the data key), per `docs/solutions/conventions/assert-what-a-branch-produces-not-what-a-lenient-classifier-concludes-from-it.md`.
- **Cron-tick log triage.** When a Railway bundle's deployment list shows only `SKIPPED` ticks with empty logs, the real logs are under the active deployment id from `railway status --json`; a cron tick re-runs the active deployment rather than creating an independent one.

## Related Issues

- #8424: this bug. #8425: the fix (open and unmerged as of this writing).
- #8360 and #8348: the miss/error-collapse class whose fix (`readRequiredSeed`) turned the silent empty 200 into the 503 storm that made this discoverable. See `docs/solutions/conventions/a-composing-handler-cannot-see-the-failures-its-dependencies-swallow.md`.
- #7845, #7862, #7871: (session history) the mirror failure in `scripts/seed-internet-outages.mjs`, where seed-meta was written alone over a stale payload ("fresh clock, stale payload"); here seed-meta was written onto the payload ("fresh clock, erased payload"). See `docs/solutions/logic-errors/retention-that-outlives-its-own-alarm.md`.
- `docs/solutions/database-issues/seeder-auxiliary-redis-writes-timeout.md`: the same `afterPublish` extra-key mechanism this fix removes from BLS, and its earlier incident.
- `docs/solutions/logic-errors/deployment-key-prefix-is-a-write-ownership-contract.md`: the `seed-meta:` prefix is not an ownership test; this doc adds the write-side half, that a `seed-meta:` override is not safe unless it also differs from the data key.
- `docs/solutions/logic-errors/bootstrap-key-health-missing-payload.md`: fresh seed-meta does not guarantee a correct payload, at the health layer.
