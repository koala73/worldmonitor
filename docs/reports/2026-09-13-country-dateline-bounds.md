# Country dateline bounds diagnosis and repair

Russia's generated extent collapsed to `[41.21, -180, 81.29, 180]`. The generator took longitude min/max over all MultiPolygon vertices, turning a country filter into a full longitude band. The defect was reproduced on base `7c6618573ee5d1df07537345e13e12e6b7c84f70`: the new regression accepted Berlin as Russian. The existing 79 coverage and military-bounds tests passed before the repair; country containment tests exercised Israel only.

The repair generates Russia as `[41.21, 19.6, 81.29, -169.7]`. West greater than east means the interval crosses the antimeridian, consistent with [RFC 7946 section 5.2](https://www.rfc-editor.org/rfc/rfc7946#section-5.2). This repository retains its existing latitude-first tuple order. The generator also updates the Railway JSON copy so a later generation cannot leave stale worker bounds.

## Validated scope

| Consumer | Diagnosis | Repair |
| --- | --- | --- |
| GetCountryCoverage protests | Country-name OR box allowed foreign events to match Russia | Recognized country identity takes precedence; geography remains a fallback for missing or unresolved labels |
| GetCountryCoverage earthquakes | Box matched foreign points; the report omitted the additional place-name fallback | Wrapped containment; place-name fallback preserved |
| GetCountryCoverage strikes | Coordinates alone could match the band | Wrapped containment; existing retirement and failure states preserved |
| GetCountryCoverage military flights | Full-span input retained flights throughout the band | Two ordinary longitude queries, independent pagination, deduplication, and final containment check |
| MCP get_airspace | Forwarded the same collapsed extent to civilian and military handlers | Split both requests, combine bounded results, retain failure and billing-denial semantics |
| MCP get_maritime_activity | Its existing pad logic explicitly treated RU as full-span | Correct generated input lets the existing wrapped filter exclude the North Sea |
| Climate disaster worker | Coordinate lookup, area ranking, and fallback center used linear longitude math | Wrapped membership, width, and center; both JSON copies regenerated |
| Published country Dataset metadata | Described Russia with a globe-spanning GeoShape | Two ordinary GeoShape boxes; country content revision advanced |

GetCountryCoverage is a Pro RPC and Russia is in its Tier-1 country set. The code defect and fixture contamination are confirmed. No paying customer's actual response, incident count, or production cache was inspected. Strike tracking is default-off; that path is defective when enabled, not evidence of current live strike contamination.

## Other countries and boundaries

| Code | Committed source extent before repair | Finding |
| --- | --- | --- |
| RU | `[41.21, -180, 81.29, 180]` | Confirmed collapse; repaired |
| FJ | `[-18.25, 177.34, -16.15, 180]` | No collapse in this simplified source; this is not proof of full archipelago coverage |
| NZ | `[-46.68, 166.49, -35.01, 178.29]` | No collapse in this simplified source; outlying territory coverage remains limited by the geometry |
| US | `[19.03, -168.08, 71.31, -66.98]` | No collapse in this simplified source; outlying territory coverage remains limited by the geometry |
| KI | No box; GeoJSON feature has null geometry | Missing geometry, not a collapsed box; no bounds invented |
| AQ | `[-90, -180, -64.38, 180]` | Valid polar extent, retained in generated data, local event containment, and maritime filtering; country flight queries explicitly unavailable |

Russia and Antarctica were the only generated extents wider than 180 degrees. The public hazard/airspace selectors already cap longitude spans at 60 degrees, so Russia stays excluded from those tools. CII scoring and its military seeder use a separate handwritten Russia extent, `19.6..180`; they do not consume the collapsed table. Their omission of negative-longitude Russian territory is a separate approximation and is unchanged here.

Bounding boxes remain coarser than polygons. The corrected Russia box still overlaps neighboring countries in Europe and Asia; recognized protest labels now prevent that overlap from overriding country identity. Coordinate-only lanes retain the disclosed approximation. France's generated extent also combines mainland and overseas geometry; that separate coarseness is unchanged. Replacing source geometry or changing CII score inputs is outside this repair.

## Verification

PR #8104 review identified two regressions in the first patch. Military responses use generated camelCase fields; fixtures had repeated the incorrect snake_case assumption, hiding loss of all but one aircraft during deduplication. The repair imports generated response types, uses `hexCode`, and checks full civilian and military field projection. The polar guard also needed to preserve Antarctica for local event containment while rejecting its full-span flight query. Both review cases failed before correction and passed afterward.

CI's `unit-shard (3)` failed two MCP weight assertions. Its source matcher counted one fetch statement inside a URL loop, while Russia can issue four requests. Airspace now declares a fixed maximum weight of 5 (one MCP request plus up to four downstream requests), measured with mocked HTTP requests for all 167 countries and both single-source modes. This raises API-plan airspace usage from 3 to 5 units per call; dedicated Pro MCP usage remains one unit per call. The published English and Chinese weight tables are updated. Other tools retain their source-based fan-out checks.

- 345 tests passed after PR feedback: generator/copy parity, country coverage, climate worker, military bounds, MCP behavior, country-code resolution, and tool weights.
- 144 crawlable-corpus tests passed, including rendered Russia Dataset metadata with two ordinary longitude boxes.
- 489 API/sidecar tests passed. The first run was blocked by sandbox `listen EPERM`; the same suite passed with local listener access.
- `npm run typecheck:api`, `npm run typecheck`, and `npm run lint:boundaries` passed.
- After the final helper cleanup and metadata revision, 11 focused containment, generator, collector, and corpus-build checks passed.
- Manual diff review checked every implementation change, known consumers, pagination bounds, polar behavior, unknown-source states, and billing-denial precedence. Simplification consolidated the two flight fetch paths and removed unnecessary internal re-exports. No dependencies, schema migrations, or browser interaction changes.

The tests use committed geometry and controlled producer/HTTP fixtures. They do not prove deployed provider freshness, production acceptance, or complete national polygon coverage. Corrected climate records require the worker's next successful publication after deployment; this task did not run a production seeder.
