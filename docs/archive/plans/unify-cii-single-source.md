# Unify the CII — one engine, server-canonical

Origin: Issue #3738 ("Security dimension is 100% GPS jamming"). Investigation showed the
mislabel is a symptom, not the bug. The bug: **WorldMonitor runs two CII engines that
diverge in formula, inputs, and output shape.** This plan unifies them.

> Reviewed 2026-05-22 by three parallel reviewers (feasibility / adversarial / coherence).
> Their verified findings are folded in. Corrections to the first draft are marked `[rev]`.

## Problem

| | Frontend engine | Server engine |
|---|---|---|
| File | `src/services/country-instability.ts` | `server/worldmonitor/intelligence/v1/get-risk-scores.ts` |
| Scoring fns | `calcUnrestScore`, `calcConflictScore`, `calcSecurityScore`, `calcInformationScore`, `calcNewsConflictFloor` | 4 inline component blocks in `computeCIIScores` |
| Inputs | ~20 `ingest*ForCII` functions | ~12 `AuxiliarySources` (post-Phase-1: ~17) |
| Output consumers | `calculateCII()` / `getCountryScore()` | RPC `getRiskScores` → MCP `get_country_risk`, API, panels |
| Cadence | recomputed live as browser streams tick | cached `risk:scores:sebuf:v2`, TTL 600 s |

Three independent divergences, not one:

1. **Input divergence.** The server's `computeCIIScores` does not *score* 8 signal families
   the frontend scores (military flights, military vessels, aviation disruptions, AIS
   disruptions, earthquakes, sanctions, temporal anomalies, HAPI). `[rev]` "Does not score"
   ≠ "cannot see" — 6 of the 8 already have a usable server source (audit table ✅), AIS
   disruptions has a relay source needing only geo-attribution, and only military vessels
   need a genuinely new classifier. See the audit table.
2. **Formula divergence.** Beyond inputs, the *blend* formulas differ structurally. Server
   `get-risk-scores.ts:549-556`: `baseline·0.4 + eventScore·0.6 + climateBoost + cyberBoost
   + fireBoost + advisoryBoost + orefBlendBoost + displacementBoost`. Frontend
   `country-instability.ts:~1014`: adds `hotspotBoost`, `newsUrgencyBoost`, `focalBoost`,
   `supplementalSignalBoost`, `getEarthquakeBoost`, `getSanctionsBoost`, and uses a
   *different* `displacementBoost` shape (server = `log10` ramp cap 20; frontend = step
   function cap 8). The component sub-formulas (`security` GPS-only vs 4-input) also differ.
   And the *frontend itself* carries two divergent blends: `calculateCII`
   (defined `country-instability.ts:975`, blend at `:1014`) includes the
   earthquake/sanctions/supplemental boosts; `getCountryScore` (`:1042`) omits all three. Phase 3a's canonical-decision list must pick
   one blend — Phase 4 then silently changes scores for `getCountryScore` consumers (an
   expected, intended change).
3. **Output-shape divergence.** The `CiiComponents` proto fields are
   `newsActivity / ciiContribution / geoConvergence / militaryActivity` — *positionally
   aliased* to `information / unrest / conflict / security` by `cached-risk-scores.ts:92-97`
   and `get-risk-scores.ts:572-577`. There is no `security` proto field.

Because both engines are user-facing (MCP/API serve the server score; the UI's
`calculateCII()` / `getCountryScore()` serve the frontend score), the MCP tool and the
on-screen CII can disagree for the same country.

## Scope boundary — "unify" is not "correct"

This plan makes the two engines produce **one** score. It does **not** fix whether that
score is *right*. Specifically: `calcSecurityScore` (flights + vessels + aviation + GPS) is
*military activity*, not "security" in the terrorism sense (issue #3738's actual complaint).
Unifying on it freezes that model. Correcting the security model is **out of scope** here,
but must not be silently dropped: filing the follow-up issue — a real security/terrorism
signal, with a named owner — is a **Phase 0 deliverable**, and #3738 is closed against that
follow-up, not against this plan's rename. Phase 0's label rename (`"Security"` → `"Mil. Activity"`) is the
honest stopgap that makes the frozen model's name accurate; it is a deliberate, lasting
decision, not a placeholder. `[rev]` This is why Phase 0 is safe to ship early: the plan
commits to "the dimension stays military-activity-only," so the label will not need
re-reverting later.

## Target architecture

**The server `get-risk-scores.ts` is the single CII engine. The browser renders its output.**

- Delete `calculateCII()`, `getCountryScore()`, `calc*Score`, `calcNewsConflictFloor`, and
  the CII-scoring state from `country-instability.ts`.
- All frontend CII consumers read the server `RiskScores` proto via the **already-built**
  `src/services/cached-risk-scores.ts` adapter (`getCachedScores`, `toCountryScore`,
  `fetchCachedRiskScores`, circuit breaker, localStorage persistence). `[rev]` This module
  already exists and several call sites already dual-path through it — Phase 4 is "remove
  the frontend-engine arm," not "build a consumption layer."
- Accepted tradeoff: the CII *number* freshness becomes the server cadence (~10 min), not
  live. Map layers stay live; only the index number follows server cadence. For a
  `baseline·0.4 + eventScore·0.6` slow index this is acceptable — but the acceptance is
  **per-consumer, not blanket**. Live-CII-dependent surfaces and their verdict:
  - `checkCIIChanges` instability alerts (`cross-module-integration.ts:561`) — delta
    detection moves from live ticks to 10-min snapshots; **needs retuning** (see Risk 4).
  - `getCountryScore` map tint (`DeckGLMap.ts` / `Map.ts` via `setCIIGetter`) — 10-min
    staleness acceptable for a country-level choropleth.
  - `story-data.ts`, `military-surge.ts` — consume CII for context, not real time; 10-min
    acceptable.
  Phase 4 confirms each consumer owner signs off; the alerts surface is the one with a real
  behavior change, not a pure latency change.

A shared-formula module ("one formula, two engines") is **rejected** — the user's decision
is one engine. Note: a shared module would eliminate *formula* divergence but not *input*
or *country-set* divergence, so it does not by itself deliver one CII.

## Per-signal source audit

The 8 families the server CII does not currently *score*, and what each needs:

| Signal | Frontend ingest | Server source today | Work |
|---|---|---|---|
| Aviation disruptions | `ingestAviationForCII` | `aviation:delays-bootstrap:v2` (Redis — pre-merged FAA + intl + NOTAM by seed-aviation.mjs) ✅ | Plumb into `AuxiliarySources` |
| AIS disruptions | `ingestAisDisruptionsForCII` | `get-vessel-snapshot.ts` emits `AisDisruption` (live relay HTTP, **not** a Redis key) ⚠️ | **Phase 2** — cached to a Redis key by Phase 2's scheduled relay job, then plumbed + **geo→country** |
| Earthquakes | `ingestEarthquakesForCII` | `seismology:earthquakes:v1` (Redis) ✅ | Plumb + geo→country |
| Sanctions | `ingestSanctionsForCII` | `sanctions/v1/list-sanctions-pressure.ts` (per-country) ✅ | Plumb |
| Temporal anomalies | `ingestTemporalAnomaliesForCII` | server-detected (`TemporalAnomalyProto`, `temporal-baseline.ts consumeServerAnomalies()`) ✅ | Plumb |
| Military flights | `ingestMilitaryForCII` | `military:flights:v1` (Redis) — **already operator-classified** by `scripts/seed-military-flights.mjs` ✅ | Per-country count + location/foreign-presence attribution |
| Military vessels | `ingestMilitaryForCII` | relay `get-vessel-snapshot.ts` has raw vessels; **no military classification/attribution** ⚠️ | Port classifier (`MILITARY_VESSEL_PATTERNS`, `KNOWN_NAVAL_VESSELS` in `src/config/military.ts`) + attribution |
| HAPI conflict | `ingestHapiForCII` | `conflict/v1/get-humanitarian-summary-batch.ts` → `conflict:humanitarian:v1:{ISO3}` ✅ | Phase 1 plumb — or take the drop decision in Phase 3a (frontend uses it only as ACLED-empty fallback) |

`[rev]` Corrections from the first draft: only **military vessels** need genuinely new
*classification* work — military flights are already classified in `military:flights:v1`;
the relay is a process (`scripts/ais-relay.cjs`) reached by per-request HTTP, not a Redis
key; AIS disruptions and earthquakes both need a geo→country step. No new persistent-
WebSocket worker is needed (the relay process already holds the streams), but "plumbing"
for AIS still means a live relay HTTP call with a timeout, not a cheap cache read.

Additional frontend-only **inputs** (feed `calculateCII` but not in the 8 families):
`focalPointDetector.getCountryUrgencyMap()` (`country-instability.ts:977`), hotspot boost
(`getHotspotBoost`), learning-mode gating (`isInLearningMode`). Decide per Phase 3a.

## Country-set divergence `[rev]`

Server `computeCIIScores` iterates `Object.keys(TIER1_COUNTRIES)` — **31 countries**
(`_shared.ts:35`, includes KR/IQ/AF/LB/EG/JP/QA). Frontend `calculateCII()` iterates
`new Set([...countryDataMap.keys(), ...Object.keys(CURATED_COUNTRIES)])` — the same 31
curated **plus any country that received ingested data** (dynamic). So after Phase 4,
non-curated countries with events lose their CII. This is a smaller gap than a reviewer
first claimed (it is *not* 31→24), but it is real: decide in Phase 3a whether to expand the
server set or accept that CII is curated-countries-only (those dynamic scores were thin —
baseline 20 + events — anyway).

## Phases

Phases 0, 1, 2, 3b, and 4 are each an independently shippable PR; Phase 3a is a
design-note decision table, not a PR. The Guardrails section below is **not** a phase —
each test ships inside an earlier phase's PR (noted per test).

### Phase 0 — Label stopgap (ships immediately, independent)

- Rename the CII component label `"Security"` → `"Mil. Activity"` in **all three**
  component blocks of `src/locales/en.json` (lines 101, 745, 3170) and the **20 non-English
  locale files** in `src/locales/*.json` (regenerate any `.d.ts` companions).
- Internal dimension key stays `security`; only the display string changes.
- File the security-model follow-up issue (#3738's actual complaint — a real
  security/terrorism signal) and link #3738 to it. **Owner: TBD — assign before Phase 0
  ships;** Phase 0 is not complete with only the rename.
- No engine change. Safe given the Scope-boundary commitment above.

### Phase 1 — Server acquires the cheap signals

- `AuxiliarySources` + `fetchAuxiliarySources()`: add aviation (`aviation:delays-bootstrap:v2` — the pre-merged FAA + intl + NOTAM source),
  earthquakes (`seismology:earthquakes:v1`, with geo→country), sanctions
  (`sanctions:pressure:v1`), temporal anomalies (`temporal:anomalies:v1`). All four are
  backed by an existing Redis key.
- `CountrySignals` + `emptySignals()`: add the count fields
  (`aviation{Closure,Severe,Major,Moderate}Count`, `earthquake{Significant,Major,Severe}Count`,
  `sanctions{Entry,NewEntry}Count`, `temporalAnomaly{,Critical}Count`).
- Wire each into the per-country accumulation loop. **No scoring change** — signals
  gathered but unused. Additive and safe.
- **AIS disruptions moved to Phase 2.** Unlike the four above, AIS disruptions have no Redis
  key — `get-vessel-snapshot.ts` fetches them from the Railway relay per request. Adding a
  live relay HTTP call into the 600 s scoring path is the anti-pattern the feasibility
  review flagged; instead AIS rides on the scheduled relay job Phase 2 already stands up.

### Phase 2 — Server military flights, vessels + AIS disruptions

- Per-country aggregation of `military:flights:v1` (already operator-classified) — add
  location-code attribution for foreign presence.
- New server-side military **vessel** classifier: port `MILITARY_VESSEL_PATTERNS` /
  `KNOWN_NAVAL_VESSELS` and apply to the relay vessel snapshot. This is the single largest
  new-build item in the plan — before committing, Phase 3a must check the vessel signal's
  weight in the CII blend; if it is marginal, **drop military vessels and document the
  accepted input gap** is a valid Phase 3a decision (mirroring HAPI's "or drop").
- Port the *intent* of `ingestMilitaryForCII`'s foreign-presence weighting — **not the
  representation hack**. The frontend fakes the ×2 weight by pushing synthetic `{}` objects
  so `array.length` inflates (`country-instability.ts:447-456`); the server must store
  honest counts and apply the ×2 in the formula, or any future reader of the new key gets a
  ~3× inflated aircraft count.
- Write per-country counts to a Redis key (e.g. `intelligence:military-cii:v1`).
- **Decision:** aggregation runs as a scheduled server job writing the Redis key (not a
  relay extension) — keeps `get-risk-scores.ts` reading Redis uniformly, matches the 600 s
  cadence, and avoids coupling scoring to relay request latency.
- **AIS disruptions (moved from Phase 1).** AIS disruptions have no Redis key —
  `get-vessel-snapshot.ts` fetches them from the relay per request. The same scheduled job
  caches them to a Redis key with geo→country attribution (`AisDisruption` carries
  `{lat,lon}` + a free-text `region`, no `countryCode`), so `fetchAuxiliarySources()` reads
  them uniformly like the Phase 1 signals — no live relay call in the scoring path. Add
  `aisDisruption{High,Elevated,Low}Count` to `CountrySignals`.
- **Attribution caveat:** the server's `geoToCountry` (`get-risk-scores.ts:154`) is a
  bounding-box scan; the frontend uses polygon containment. For straits/borders (Hormuz,
  Taiwan Strait, Black Sea — the high-signal cases) bbox will mis-attribute. Either port
  polygon containment server-side or accept and document the precision loss.

### Phase 3a — Reconciliation decisions (design note, no code)

"Port verbatim" is **not** sufficient — the formulas diverge structurally and at least one
divergence is intentional. Before the behavior-changing PR opens, settle every decision
below and record it in a signed-off table. Phase 3b executes this table; it does not make
decisions inside the PR.

- For **each** of the 4 component formulas and **each** blend boost
  (`hotspotBoost`, `newsUrgencyBoost`, `focalBoost`, `supplementalSignalBoost`,
  `earthquakeBoost`, `sanctionsBoost`, `displacementBoost`), a **canonical decision**: which
  engine's formula wins. Default = frontend, **except** where the server intentionally
  diverged — e.g. the `information` cap was deliberately raised 20→100 in issue #3739
  (`get-risk-scores.ts:518-521`); the server version wins there.
- The `BASELINE_RISK` / `EVENT_MULTIPLIER` scalar-table reconciliation.
- The `getScoreLevel` threshold reconciliation — frontend `getLevel` (≥81 / ≥66 / ≥51 /
  ≥31) vs server adapter `cached-risk-scores.ts getScoreLevel` (≥70 / ≥55 / ≥40 / ≥25).
  Even identical scores render different `level` badges until this is unified.
- focal-urgency / hotspot-boost / learning-mode: **port if reproducible from
  server-available signals, drop otherwise**.
- The country-set question (Risk 6: expand server set, or accept curated-only).
- The Phase 3-proto field-naming choice (below).
- The Risk 3 cold-cache decision.
- Signal→component mapping: for each newly-plumbed signal (Phase 1 — aviation, AIS
  disruptions, earthquakes, sanctions, temporal anomalies; Phase 2 — military
  flights/vessels), which component it scores into and with what sub-formula. The boost
  list above does not cover signal→component mapping; an unmapped signal gets silently
  dropped or invented inside Phase 3b.
- The `ingest*ForCII` side-effect decomposition for Phase 4: enumerate which non-CII side
  effects (e.g. `trackHotspotActivity` → `hotspotActivityMap`) survive the deletion and
  which feature consumes each. Phase 4's irreversible deletion is gated on this table.

### Phase 3b — Server computes the full CII (implementation)

This is the behavior-changing PR. It **executes** the Phase 3a decision table — it makes no
decisions. Implement each canonical formula choice, the scalar tables, the `getScoreLevel`
thresholds, and the proto change. Pair with the Guardrails equality/level/attribution tests
below; the PR is not done until the equality test is green.

### Phase 3-proto — `CiiComponents` field naming

Folded into the Phase 3b PR (same cache-key bump); the keep-vs-rename choice is made in
Phase 3a. Decide: keep abusing the positional
aliases (`militaryActivity`≡`security`, …), or rename the `.proto` fields to
`unrest/conflict/security/information` and regenerate
`src/generated/server/worldmonitor/intelligence/v1/service_server.ts` +
`src/generated/client/worldmonitor/intelligence/v1/service_client.ts`. Either way the
`CiiScore` shape changes → **mandatory** bump of
`RISK_CACHE_KEY` (`v2`→`v3`) propagated to every reader listed at `get-risk-scores.ts:626-631`.

### Phase 4 — Frontend becomes a renderer

- Repoint every CII consumer to `cached-risk-scores.ts` — both `calculateCII()` and
  `getCountryScore()` consumers. The `rg 'calculateCII|getCountryScore' src/` sweep is
  authoritative and must be run before starting; the known sites are:
  `country-intel.ts:218,740`, `data-loader.ts:348`, `search-manager.ts:710`,
  `CIIPanel.ts:134`, `story-data.ts:65`, `src/services/cross-module-integration.ts:561,630`,
  the internal `country-instability.ts:1038` (`getTopUnstableCountries`), and the
  `getCountryScore` path: `DeckGLMap.ts` / `Map.ts` (via `setCIIGetter`), `InsightsPanel.ts`,
  `military-surge.ts`.
- `search-manager.ts:710` (`panelScores.length > 0 ? panelScores : calculateCII()`): the
  fallback arm is **removed**, the line keeps the `panelScores` arm. It is not "converted
  to a proto consumer" — `panelScores` already is one.
- Delete `calculateCII`, `getCountryScore`, `calc*Score`, `calcNewsConflictFloor`.
- **Surgical:** the `ingest*ForCII` functions have non-CII side effects (see Risk 1) — keep
  the ingestion, delete only the CII scoring state. Use the side-effect decomposition table
  produced in Phase 3a; do not leave it to per-engineer judgment.

## Guardrails (not a standalone phase — each test ships in the phase noted)

These are not an independently shippable phase; each test lands inside an earlier phase's PR.

- **Equality test (lands with Phase 3b):** feed identical fixture *component-input* signals
  to the server formulas and the frontend `calc*Score` functions; assert byte-identical
  component scores. This is *formula parity* only — a green equality test is necessary but
  **not sufficient** for UI parity (see Principle).
- **Level-parity test (lands with Phase 3b):** assert the rendered `level` badge matches
  across engines for the same score, gated on the Phase 3a `getScoreLevel` reconciliation.
  Identical component scores still render different badges until thresholds are unified —
  the equality test does not catch this.
- **Attribution-parity test (lands with Phase 3b, one-shot while both engines coexist):**
  feed real coordinates (straits, borders) through both the server bbox and frontend
  polygon attribution; assert the country assignment matches, or document the accepted
  deltas. The equality test alone is blind to this (Risk 2). The frontend attribution is
  deleted in Phase 4, so this is a transition check, not an ongoing guardrail.
- **Standing attribution regression test (permanent — survives Phase 4):** a fixed
  coordinate-set → expected-country fixture for the server's `geoToCountry`, independent of
  the frontend. The one-shot attribution-parity test validates the port; this guards
  against future bbox drift once the frontend polygon attribution is deleted.
- **Source-grep test (lands with Phase 4):** fails if `calculateCII` / `getCountryScore` /
  `calc*Score` reappear in `src/`.

## Principle

The server CII and the frontend CII are **one metric** — after Phase 4 only the server
engine exists, so equality is structural. *During* the transition (Phases 1–3) "equal"
means **formula parity given identical inputs**, verified by the Guardrails equality test.
Full production equality additionally requires input parity and attribution parity, which
the Guardrails attribution-parity test covers. Note: byte-equality cannot be asserted against the
*current* server `information` block — it intentionally diverged (#3739); Phase 3a resolves
which side is canonical before the equality test can pass.

## Risks / gotchas

1. **`ingest*ForCII` have non-CII side effects.** `ingestMilitaryForCII`,
   `ingestProtestsForCII`, `ingestConflictsForCII` call `trackHotspotActivity`
   (`country-instability.ts:258,270,424,444`), feeding `hotspotActivityMap` consumed by
   `getHotspotBoost`. Phase 4 deletes scoring, not ingestion — decompose each function.
2. **Formula parity needs input + attribution parity.** Porting `calcSecurityScore`
   byte-for-byte while feeding differently-attributed arrays still drifts. The Guardrails
   attribution-parity test guards this; the equality test alone does not.
3. **Cold-cache failure mode.** On a cold Redis cache + upstream failure, the server
   returns 31 countries scored on **baseline only** (`get-risk-scores.ts:694-700`:
   `computeCIIScores([], emptyAux)`). Today the frontend fallback masks this by recomputing
   from live in-browser streams. Phase 4 removes that mask. **Decision required before
   Phase 4:** either keep a thin client-side fallback for the empty-result case, or accept
   a degraded baseline-only CII on cold start. Do not delete the fallback silently.
4. **`cross-module-integration.ts` is stateful.** `checkCIIChanges()` (line 561) keeps
   alert history in a module-level `previousCIIScores` Map and gates on `isInLearningMode()`
   (frontend-only state). Moving to a 600 s server cadence changes delta-detection
   semantics (two snapshots 10 min apart, not live ticks). This is a behavior change, not
   just an availability concern — re-validate against the learning-mode decision in Phase 3a.
5. **Cache key bump is mandatory, not conditional** — see Phase 3-proto.
6. **Country-set shrink** — see "Country-set divergence"; decide in Phase 3a.

## Sequencing notes

- Phase 0 ships today; safe given the Scope-boundary commitment.
- Phases 1–2 are additive (signals gathered, not scored) — safe, provided no proto change
  ships with them (it ships with Phase 3b).
- Phase 3a is a design note (decision table), not code; it is authored **after Phases 1–2
  land** so the vessel-weight check has real data, and its cited formula line numbers are
  re-verified against current source at the start of Phase 3b. Phase 3b (executing that
  table, + Phase 3-proto + the Guardrails equality/level/attribution tests) is one PR — the
  behavior-changing one. It is not done until the equality test is green and every
  per-component canonical decision from 3a is recorded.
- Phase 4 is the deletion PR — largest blast radius. Gate it on the Risk 3 (cold-cache),
  Risk 4 (alert retuning), and Risk 6 (country-set) items being resolved and signed off.
- Revertability: Phases 0–3 revert cleanly. Phase 4 deletes code — reverting it means
  restoring the deleted engine *and* the `ingest*ForCII` decomposition. Treat Phase 4 as
  the point of no return.

## Deferred / Open Questions

### From 2026-05-22 review

- **Cold-cache fallback decision (Risk 3).** Phase 4 deletes the frontend engine that today
  masks the cold-cache failure mode — on cold Redis + upstream failure the server returns
  31 baseline-only scores (`get-risk-scores.ts:694-700`). Decide before Phase 4: keep a
  thin client-side fallback for the empty-result case only, or accept a degraded
  baseline-only CII on cold start (and decide whether a degraded score needs a UI staleness
  indicator). This is an architecture/UX call that depends on tolerance for a cold-start
  baseline-only CII — it cannot be auto-resolved. Blocks Phase 4. (adversarial, product-lens)
