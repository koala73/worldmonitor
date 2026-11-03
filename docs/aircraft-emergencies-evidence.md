---
noindex: true
---

# Aircraft emergency signals

The opt-in Aircraft emergencies layer shows reported squawks 7500, 7600, and 7700 on the desktop and SVG/mobile maps.
It does not confirm an incident, its cause, a landing, or a resolution.
The globe does not offer this layer.

## Aviation and provider contract

[FAA AIM 4-1-20](https://www.faa.gov/Air_traffic/publications/atpubs/aim_html/chap4_section_1.html) describes transponder operation and warns that momentary selections can cause false alarms.
[FAA AIM 6-3](https://www.faa.gov/air_traffic/publications/aim_html/chap6_section_3.html) describes emergency assistance and verification of code 7500.
[FAA radar procedures](https://www.faa.gov/Air_traffic/publications/atpubs/atc_html/chap5_section_2.html) identify code 7600 with loss of two-way radio communication.
These references explain code meanings. They do not verify any aircraft in this layer.

| Exact `squawk` string | Displayed reported condition |
| --- | --- |
| `7500` | Unlawful interference signal |
| `7600` | Radio communication failure signal |
| `7700` | General emergency signal |

Admission requires an exact four-character string. Spaces, prefixes, ordinary codes, numeric coercion, and the separate ADS-B `emergency` field do not admit a record.
Military classification is not an admission requirement.

The selected provider is [adsb.lol](https://api.adsb.lol/docs), using `/v2/sqk/7500`, `/v2/sqk/7600`, and `/v2/sqk/7700`.
Its [API implementation](https://github.com/adsblol/api) uses readsb-compatible aircraft fields.
The [readsb field definitions](https://github.com/wiedehopf/readsb/blob/dev/README-json.md) distinguish `squawk` from the separate `emergency` status.
They define `seen` as the age of the last message and `seen_pos` as the age of the last position update.
Neither field establishes when the squawk itself was selected.

| Provider fields | Preserved meaning |
| --- | --- |
| `hex` | Address, lowercased. A `~` prefix remains a separate non-ICAO namespace. |
| `flight`, `r`, `t`, `desc` | Callsign, registration, type, and description. Missing values display as Unknown. |
| `dbFlags` bit 0 | Provider military database flag. An unset bit is not proof of civilian status. |
| `squawk` | Exact reported Mode A code. |
| `now`, `seen` | Observation time is provider time minus message age. Retrieval never resets this clock. |
| `lat`, `lon`, `seen_pos` | Separate position and position clock. Zero coordinates remain valid. |
| `alt_baro`, `gs` | Optional feet and knots. Missing values remain unknown. `ground` does not become altitude zero or a landing claim. |

Captured adsb.lol response clocks are epoch milliseconds. The parser also accepts epoch seconds, as documented for readsb.
A missing response clock, a clock more than 30 seconds ahead of retrieval, or a malformed array makes that query unavailable. Smaller clock drift is accepted, and no report is dated after its retrieval; the browser applies the same 30-second tolerance. A malformed row, or an emergency row with an invalid address, is skipped without discarding the rest of the response.
Missing, negative, or nonnumeric age fields remain unknown. Invalid coordinates do not receive a marker.

Observation freshness is at most 120 seconds. Position freshness is at most 90 seconds.
Only a current observation with a fresh position gets a map marker. Other records remain inspectable in the aircraft list.
The browser checks each minute while visible and reevaluates displayed ages every five seconds.
The handler shares a 30-second cache. The gateway does not add a CDN cache.

Exact duplicate observations collapse. One address produces one aircraft row.
Within the 15-minute retention window, differing codes remain a conflict regardless of source order. Expired observations are removed individually before conflict classification, including undated reports alongside a fresh source.
Equal position clocks with differing coordinates also remain a conflict. Conflicts do not receive markers.
The details retain each conflicting observation and its source. The implementation currently queries one provider, so cross-provider cases are synthetic tests only.
For agreeing codes, the newest message time determines the representative report; details and coordinates are never combined across observations.

A later dated response with a new code replaces the prior code for that address. An older dated response cannot overwrite a newer observation. An undated code change cannot be ordered against a retained dated report; both remain inspectable as conflicting evidence until an unexpired newer timestamp orders them.
Conflicting reports at the same observation clock remain conflicting when one disappears; a newer observation is required to replace that evidence.
If an aircraft disappears, including after an ordinary code change, its current condition becomes unknown.
The squawk queries cannot distinguish a code change from reception loss.
No disappearance means resolved, landed, or safe.
Unknown observations expire 15 minutes after their source observation time. With no source observation clock, retention starts at first receipt and does not extend on repeated unknown data. After payload expiry, only address/first-receipt bookkeeping remains while those reports continue. An unexpired timestamped report with no undated reports, or a fresh successful absence across all three queries, clears that bookkeeping. Reappearance after that absence starts a new receipt period and does not merge the previous undated code into the new period. Unavailable or partial data cannot clear it.

Each code query reports availability separately. HTTP failure, timeout, invalid JSON, and schema failure are unavailable. When all three queries are unavailable, the response is not cached as data and is served with no-store.
Fresh successful empty arrays mean no matching squawks reported by that provider, within its reception coverage.
A stale provider response is not a fresh empty result. Matching reports whose payloads expired show an expired-observation message, not an empty-feed message. Partial successes retain their observations alongside failed query statuses.

## Before-edit feed evidence

Unaltered response bytes and retrieval metadata are in `tests/fixtures/aircraft-emergencies/captured/`.
Metadata contains the URL, UTC receipt time, HTTP status, and SHA-256. The replay test verifies every hash.

| UTC receipt on 2026-10-15 | Query | Observed result |
| --- | --- | --- |
| 17:44:58.134 | adsb.lol `/v2/mil` | 405 rows, all with military database bit set. |
| 17:44:58.663 | adsb.lol `/v2/sqk/7500` | HTTP 200, empty aircraft array. |
| 17:44:59.217 | adsb.lol `/v2/sqk/7600` | HTTP 200, empty aircraft array. |
| 17:44:59.702 | adsb.lol `/v2/sqk/7700` | HTTP 200, empty aircraft array. |
| 17:45:00.661 | adsb.fi London-area point query | 108 rows, none with military database bit set. |
| 17:46:23.980 | adsb.lol London-area point query | 107 rows, none with military database bit set. |

An airplanes.live point request returned HTTP 403 in the same bounded check.
Wingbits and authenticated OpenSky were not captured live because this worktree had no provider credentials.
Their existing adapters and the [OpenSky state-vector definitions](https://openskynetwork.github.io/opensky-api/rest.html) were inspected. No claim is made about their current live coverage.

The demonstrated coverage gap is the project's military-only primary request. It cannot provide civilian emergency inclusion.
The regional point queries also cannot establish coverage outside their regions.
The selected provider demonstrably carries military-flagged and non-military-flagged aircraft, and offers code queries without a military restriction.
These captures do not prove detection of any live emergency, completeness across civilian or military aircraft, or global reception.
Transponder silence, withheld aircraft, receiver gaps, missing squawks, and delayed positions remain outside the evidence.

## Field trace and implementation boundary

The military seeder converts readsb fields to OpenSky-shaped indexes.
`hex`, `flight`, `squawk`, longitude, latitude, last message time, and position time become indexes 0, 1, 14, 5, 6, 4, and 3.
Military classification then filters records before the Redis snapshot and military API.
The generated military client maps them into `MilitaryFlight`, which keeps squawk and last message time but drops separate position freshness.
The aircraft tracking API emits `PositionSample` without squawk. Neither display path can satisfy this layer unchanged.
Wingbits admission uses `h`, `f`, `sq` or `squawk`, `la`/`lo`, and `ra`/`ts` through a regional adapter.
OpenSky defines address, callsign, position time, last contact, longitude, latitude, and squawk at indexes 0, 1, 3, 4, 5, 6, and 14.

The new aviation RPC preserves its own observations and per-query availability.
The browser service passes these to a layer controller, which owns bounded local retention, the aircraft list, and fresh markers.
The emergency feed does not admit civilian aircraft into military datasets.
Aircraft that meet military admission criteria remain in the military layer, counts, clusters, surge summaries, and posture inputs when they report 7500, 7600, or 7700. They can also appear in the emergency layer.
Changing squawk alone does not remove a qualifying aircraft from the military layer. The separate emergency feed does not rewrite existing posture snapshots.

## Replay proof

`tests/aircraft-emergencies.test.mts` verifies the unaltered captures, then uses `synthetic.json` for positive and edge cases.
All positive emergency examples are labeled synthetic. None describes an observed incident.

| Representative input | Expected result |
| --- | --- |
| Captured empty squawk responses | Available, zero current records. |
| Captured military and regional ordinary-code aircraft | No emergency rows. |
| Synthetic `a00001`, `7500`, `seen=2`, `seen_pos=3`, provider clock 18:00:00Z | 7500 reported signal; message 17:59:58Z; position 17:59:57Z; known details and marker. |
| Synthetic 7500/7600/7700 with military flag set or unset | Six emergency aircraft rows. The three military-flagged aircraft also retain military admission. |
| Synthetic missing or stale position | Aircraft details remain; no current-position marker. |
| Synthetic duplicate address or conflicting code/position | One row; conflicting evidence remains unknown and unmarked. |
| Synthetic later 7600, then older 7500 | Later 7600 remains. No cause or resolution claim. |
| Synthetic undated 7600 after dated 7500 | Both codes remain conflicting and unmarked until a newer dated observation orders them. |
| Synthetic expired code alongside a fresh source, including undated conflicts | Each expired observation leaves the payload and cannot withhold the fresh marker. |
| Synthetic repeated unknown clocks through 45 minutes; complete absence then reappearance | Continuous reports do not renew expiry. Reappearance after confirmed absence starts a new receipt period. |
| Synthetic empty response, failure, or reception loss | Distinct availability; previous aircraft become unknown and expire. |

The relay subprocess tests inject all three emergency codes into adsb.lol, Wingbits, and OpenSky fixtures.
Each source publishes its one ordinary military aircraft and all three emergency-squawking military aircraft to posture calculations.

## Browser proof and live limits

The repeatable browser step is `.agents/skills/verify-worldmonitor/steps/aircraft-emergencies.mjs`.
It controls only the emergency RPC response and browser clock while using real dashboard assets and controls.
Desktop uses the DeckGL layer control. Mobile uses Search to toggle the layer because the mobile Map tab hides desktop controls.
The step checks code details, URL/storage state, conflicts, missing positions, feed failure, expiry, empty success, toggle-off, and reload.
It does not exercise the deployed gateway, production Redis, or provider ingestion.

| Run on 2026-10-15 UTC | Result |
| --- | --- |
| 18:16:39 and 18:46:09, mobile 390×844, SVG | Full controlled replay passed, including six markers and their removal. The later run includes the final CSS integration. |
| 18:19:04, desktop 1440×1000, DeckGL | Full controlled replay passed for details and layer state. |
| 18:24:29, 18:43:51, 19:06:07, 19:22:20 and 19:27:28, desktop, native animation timers | Loaded map displayed synthetic markers; selecting Washington opened `RCH7500`. The final run includes the retention repair. |
| 19:05:30, 19:21:47 and 19:26:56, mobile 390×844, SVG | Full replay passed. Repeated unknown-clock reports expired and stayed absent while the feed remained available. The final run also shows an undated code change as conflicting evidence before a newer dated report replaces it. |

The native-frame check uses `WM_VERIFY_HEADED=1 WM_VERIFY_CURRENT_ONLY=1` with the same step.
The full timer replay can advance before the WebGL base map finishes loading, so it is not the desktop marker proof. A final mobile attempt at 18:44:23 timed out after a clock jump raced asynchronous polling; synchronizing the recovery response passed at 18:46:09.
[Desktop screenshot](evidence/aircraft-emergencies/desktop.png), [mobile screenshot](evidence/aircraft-emergencies/mobile.png), and [expired observation screenshot](evidence/aircraft-emergencies/expired.png) show synthetic data.
The local dashboard also logs missing session/legacy route errors and unavailable unrelated feeds; the replay deliberately induces emergency RPC HTTP 503 responses. These runs are not a clean live dashboard health check.

Local verification passed with Node 24: 46 focused capture/freshness/military tests, 558 sidecar/API tests, 77 map contract tests, 25 MCP parity tests, route-cache tests, both TypeScript checks, import boundaries, API/rate-limit contracts, safe HTML, source attribution, focused Biome, Markdown lint, and `git diff --check`.
The CI integration repairs also passed 91 layer/widget/OpenAPI-example tests, 28 DOM tests, 17 map lifecycle tests, 19 AI-search fact tests, and 45 product-fact/catalog tests. Existing cache identity checks pass while emergency-squawking military records remain included.
Run the focused tests with `node --import tsx --test tests/aircraft-emergencies.test.mts tests/seed-military-flights-adsb.test.mjs tests/military-surges.test.mjs tests/military-flight-pagination.test.mts tests/military-flights-bounds.test.mts`.
Run relay/API verification with `npm run test:sidecar`. Generated clients and OpenAPI were regenerated with pinned `make generate`.
The final API examples label the aircraft synthetic, preserve unknown details, and use exact valid codes and availability values. The endpoint description distinguishes the unprojected response schema from an optional JMESPath result.
The shared OpenAPI emitter also hoists byte-identical reference schemas with sibling descriptions. Its 44 round-trip tests and 43 capacity/projection checks pass. The emitted JSON is 949,039 bytes under the fixed 950,000-byte limit; the 961-byte reserve remains tight.

The initial raw captures are bounded live provider observations. Replay proof is separate from browser proof.
The local unmocked dashboard displays unavailable data when required gateway dependencies are absent.
No deployment, production emergency display, or production acceptance is claimed.
