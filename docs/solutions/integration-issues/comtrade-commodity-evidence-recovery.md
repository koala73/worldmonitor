---
title: Comtrade commodity evidence and cache recovery
module: supply-chain
problem_type: integration_issue
date: 2026-09-11
issue: 7990
---

# Scope and current evidence

This repair keeps numeric partner codes, stored shares, and source clocks intact. It does not certify procurement readiness. Issue #7990 must remain open for the live and route acceptance items below. Presentation work in PR #7985 is separate.

Read-only Redis GETs on 2026-09-11 reproduced the published issue observations through `loadEnvFile` and `readSeedSnapshot({strict:true})`. No seed, refresh, or cache write ran against production.

| Cache | Fetch timestamp UTC | Headings | Relevant evidence |
| --- | --- | --- | --- |
| JP | 2026-09-01 06:05:21 | 36 | HS2804, 2024; partner 842 has empty ISO and share 0.392 |
| US | 2026-09-01 06:03:36 | 36 | HS2804, 2024; partner 579 has empty ISO |
| DE | 2026-07-27 16:47:53 | 20 | HS2804/2836 absent; HS1001 year 2023 |

Aggregate metadata had `recordCount:160`, `status:ok`, and `preserveStreaks.DE:1`. This proves preservation, not the historical provider response. The September run's specific Germany failure cannot be reconstructed from these old metadata fields. Keep that historical cause unverified unless deployment-specific logs establish it.

# Reproduced causes and changes

- Both producers used a standard UN code lookup. The provider's [partner reference](https://comtradeapi.un.org/files/v1/app/reference/partnerAreas.json), retrieved 2026-09-11, explicitly maps 842 to US, 251 to FR and 579 to NO. Their customs areas include named territories; the exported partner scope retains that distinction. Code 490 is “Other Asia, nes” without a country ISO, so the Taiwan reporter override is not applied. Current provider entries take precedence over a standard-code fallback; historical, aggregate and special entries stay non-country rows.
- Scheduled ingestion requests 36 headings, while the lazy producer requested only the original 20. Both now use one catalogue and grouping implementation. A legacy 20-heading cache can therefore be investigated without waiting for expiry. This mismatch is a demonstrated recovery defect, not proof that the lazy producer created Germany's July record.
- Scheduled HTTP failures were returned as empty arrays. A successful first batch and failed second batch could publish a smaller country payload. HTTP errors and malformed/truncated data now reject the country attempt and preserve the previous payload. Valid empty results remain `no_records`, not provider failure or zero trade. Per-country attempt states and missing headings are recorded in seed metadata.
- Both producers retain the bounded two-request catalogue shape. The monthly freshness/quota gate is unchanged. Lazy recovery has a shared five-second provider deadline and no fallback year; an older valid annual observation can remain in the preserved cache. The public [preview cap is 500 records](https://uncomtrade.org/docs/what-is-data-preview/). A response at the explicit record limit is treated as incomplete. A short response still does not independently prove worldwide reporting completeness.
- The country-products reader normalizes old cached identities without rewriting shares. It passes the cache source/fetch timestamp, requested and missing headings, and refresh outcome into capture and exports. Requested headings with no returned positive rows are distinguished from unrequested legacy coverage. Cache read errors do not start a recovery write.
- Cold lazy writes use NX. Warm recovery uses the existing 24-hour lazy cache, so it cannot replace a newer scheduled canonical write. A warm result must retain every previous heading at an equal or later observation year. Obsolete warm results do not replace newer canonical evidence.
- `/api/seed-health` exposes preserved countries and per-country heading gaps even when the aggregate producer count is `ok`. Old metadata identifies preserved countries but cannot identify its missing headings. This is explicit, not inferred complete coverage.

The comparison's vulnerability context uses `seed-supply-vulnerability.mjs` -> `getCountryVulnerabilities`; its import concentration uses numeric shares without filtering on partner ISO, so this identity fix does not change that calculation. `get-route-impact` also normalizes legacy origins. Other derived exposure caches still require a normal authorized producer cycle before their legacy contents can be claimed recovered.

# Commodity scope

All exposed mappings now carry their HS2022 basket name from the [H6 reference](https://comtradeapi.un.org/files/v1/app/reference/H6.json), retrieved 2026-09-11. Existing stage-specific caveats remain.

- HS2804: hydrogen, rare gases and other non-metals. HS280429 is narrower but still covers rare gases other than argon, not helium alone. No helium-only internationally harmonized series was established in this investigation. Retain the proxy; do not derive helium shares from either basket.
- HS2836: carbonates/peroxocarbonates, not lithium alone. This is not battery-grade qualification or supplier capacity.
- HS1001: wheat and meslin. Customs calendar-year import values and marketing-year food balances are different observations.

Shares are import-value shares, not physical volume. Only leading partner rows are stored. Unresolved, duplicate-area, self, invalid and unlisted shares are not redistributed among displayed origins. New ingestion uses the reported World total for the same observation year when available, otherwise the sum of observed partner values; the basis is exported. World is excluded from ranked origins. A partner sum exceeding the World total by more than 0.1% rejects the attempt. The legacy denominator has not been independently reconciled to a complete World total. Capacity, vendor qualification, price, transport mode and lead time remain unknown.

# Route measurement and residual acceptance

Measured against the current route/port-cluster registries on 2026-09-11, using the actual cached candidate origins above:

| Selection | Candidate origins | Pairs with a model |
| --- | --- | --- |
| JP HS2804 | US, CN, DE, VN, QA | 4/5; US unknown |
| JP HS1001 | CA, US, AU, FR, NL | 3/5; CA and US unknown |
| US HS2804 | CA, BR, DE, AU, NO | 4/5; AU unknown |
| DE HS1001 | CZ, FR, SK, HU, AT | 5/5, not validated shipment paths |

Qatar-Japan intersects `qatar-asia-lng` with Hormuz and Malacca. US-Japan has no intersection. No route was invented to fill that gap. Shared route IDs can overstate pair coverage: e.g. Australia-Japan shares a Gulf route, and inland European pairs can share an Asia-Europe route. These matches require a separate geography/transport review; a count of models is not a count of validated transport paths. The comparison labels paths as models, treats unmodeled pairs as unknown, keeps chokepoints unordered, and does not treat a downstream Suez/Cape option as bypassing a Hormuz-blocked origin.

# Recovery, verification and rollback

1. After separate approval to merge/deploy, deploy the reader and scheduled producer together. The optional protobuf request/response fields are additive; existing cached rows remain readable. No destructive key migration is needed for identity recovery.
2. Use an authenticated `get-country-products?iso2=JP&hs4=2804` request, capture the comparison, and export HTML/JSON. Verify the stored US share remains 39.2%, code 842 and provider scope survive, and observation year differs from retrieval time. Compare the actual API payload with the source cache. A fixture screenshot is not this proof.
3. For Germany, requesting a missing heading permits bounded public recovery. A capped/error/older/incomplete result must keep the July payload and disclose the reason. A successful warm result is retained separately for 24h. Do not delete the old country key to force recovery.
4. Use the next natural scheduled run, or a separately authorized scoped refresh only after checking the remaining provider quota. Inspect `countryCoverage.DE`, its missing headings, source/fetch time, observation years and the authenticated API/UI. A green aggregate count alone is insufficient. Do not bypass the monthly gate to clear a health warning.
5. Compare `seed-meta:comtrade:bilateral-hs4`, `/api/seed-health`, country payloads, and actual exports. Fail acceptance if an unresolved origin disappears without disclosure, shares inflate, fetch time is presented as trade year, or incomplete recovery replaces last-good data.
6. Roll back application/worker revisions if these checks regress. Keep canonical country payloads. Warm recovery entries expire after 24h; any targeted deletion requires explicit authorization. No rollback should erase last-good records or force a quota-consuming seed.

Local proof includes failing-before-fix partner, catalogue, HTTP-failure, malformed-response and cap tests; real scheduled write-path tests; reader -> generated client/premium fetch -> capture -> builder -> DOM/embedded JSON; browser desktop/mobile captures and downloaded HTML/JSON parity. Browser responses are controlled fixtures using the shared ingestion normalization; they are not live Comtrade observations. The authenticated deployed API, natural post-deploy producer run, historical Germany failure and broader route validity remain open acceptance items under #7990.

# Follow-up (plan 2026-09-11-001)

Dated 2026-09-11. This section records what the follow-up investigation measured and the design choices it fixed. It does not claim any production run, deploy or live acceptance.

## The 500-row cap was row multiplicity, not heading count

The record limit above was read as a heading-count problem. It is not. Without `partner2Code=0`, `motCode=0` and `customsCode=C00`, Comtrade returns one row per partner, second partner, mode of transport and customs procedure — about nine rows for each partner. Probing the public preview route on 2026-09-11 with no key: a 20-heading batch for Germany returned 500 rows covering only 4 headings, and a single heading, Germany HS2804, filled 500 rows on its own from 53 partners. Whole-catalogue recovery therefore ended `incomplete` for Germany, China and the United States on every batch, which are the importers the issue was raised about.

With the three aggregate filters, the same single-heading request returned 55 rows: all 55 partners plus the World row (partner code 0, primary value 1,133,325,717.874, net weight 691,380,182.623 kg). A 20-heading batch still reached 500 rows for Germany, China and the United States, because large importers carry roughly 40 to 110 partners per heading. So the filters make single-heading recovery fit comfortably; they do not make a whole-catalogue pull fit on the preview route. Both producers now send the filters. Neither did before; `seed-recovery-import-hhi.mjs` already sent two of the three, which is where the shape was taken from. The seeder's existing "maximum value per partner" grouping had been selecting the aggregate row all along, so stored values do not change — only the row count and the payload size.

The authenticated `data/v1/get` route was verified once, at a cost of two quota requests, before the rest was built, because the filter names had only been observed on the preview route. Germany, HS2804, 2024, with the filters: HTTP 200, 55 rows, identical to the preview result. The all-reporter export request for catalogue batch 1 (20 headings, `flowCode=X`, `partnerCode=0`, reporter omitted): HTTP 200, 2,308 rows covering 140 reporters and all 20 headings, in 2.0 seconds. The keyed route accepts the filters, and world exports for the whole catalogue cost 2 requests per run.

## Deeper partner evidence lives in a sibling key

The obvious change — widen `topExporters` on `comtrade:bilateral-hs4:{iso2}:v1` — would have altered published scores silently. Three consumers sum over every row of that list: import HHI in `scripts/seed-supply-vulnerability.mjs`, the HS2 exposure loop in `scripts/seed-hs2-chokepoint-exposure.mjs`, and `computeFlowWeightedExposures` in `server/worldmonitor/supply-chain/v1/chokepoint-exposure-utils.ts`. A longer list changes vulnerability bands and chokepoint indices with no method-version bump and no reseed to explain the movement.

Payload size is the second constraint. `scripts/seed-supply-vulnerability.mjs` and `scripts/seed-hs2-chokepoint-exposure.mjs` each read every country key through a Redis pipeline batched by key count, not by bytes — `readRedisSnapshots` defaults to `batchSize = 250` — so whatever the canonical payload grows to arrives in one response body that nothing bounds. The byte ceiling that exists, `MAX_SHARD_PIPELINE_BYTES` at 4.5 MB (`scripts/seed-supply-vulnerability.mjs:703`), governs that seeder's shard writes, not these reads. It is the size order these pipelines are built for, and the canonical payloads were measured at roughly 3.6 MB in this review, so adding even weight fields to the canonical key would push an unbounded read toward it. Chunking `readRedisSnapshots` by bytes is recorded as follow-up work; until that lands, the canonical key is the wrong home for per-origin detail.

The threshold partner list therefore goes to `comtrade:bilateral-hs4-partners:{iso2}:v1`, a sibling of the canonical key with the same 40-day TTL and the same preservation rules, read only by `get-country-products`. The canonical key keeps the leading-five contract unchanged, which is what makes the scorers provably unaffected rather than merely believed to be. World exports go to a single run-level key, `comtrade:world-exports-hs4:v1`, for the same reason: it is per-heading and reporter-wide, not per-country, so no bulk country reader grows.

## Recovery is sentinelled per heading, not per country

Single-heading recovery writes `comtrade:bilateral-hs4-lazy-heading:{iso2}:{hs4}:v1` and nothing else. Reusing the existing per-country lazy sentinel was rejected: one heading's `no_records` or provider failure would then suppress recovery of every other heading for that country for 24 hours, which is the opposite of the defect being fixed. The per-heading sentinel also keeps a cold single-heading result from ever becoming a country payload — one heading is not an import basket, and the canonical key must not be written from it. A recovered heading carries its own fetch time, and a result whose observation year precedes the stored year is rejected, so the year-regression rule above continues to hold on the narrower path.

## OpenAPI byte budget

The additive protobuf fields cost roughly 2,800 bytes in `public/openapi.json`, which sat 81 bytes under its 950,000-byte scanner budget. Rather than drop documented fields, `scripts/openapi-dedup-responses.mjs` now shortens the `JmespathParam` Parameter Object copies that `ensureInlineTypedInput` restores inline: the inline copy carries a short lead sentence and a pointer, while the component keeps the full caveats, limits and documentation link. That description was 403 bytes restated on 62 operations, about 25 KB, so the change frees far more than the new fields consume. `tests/openapi-json-dedup.test.mjs` pins both the shortened inline copy and the untouched component description.
