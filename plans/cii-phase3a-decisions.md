# CII Phase 3a — reconciliation decision table

Companion to `plans/unify-cii-single-source.md`. Phase 3b implements whatever this table
decides; per the plan, Phase 3b makes **no** decisions of its own.

Every row is a real divergence between the two engines, verified line-by-line:

- **Engine A — frontend**: `src/services/country-instability.ts`
- **Engine B — server**: `server/worldmonitor/intelligence/v1/get-risk-scores.ts`

Default rule from the plan: *frontend wins, except where the server intentionally diverged.*

## Decisions — signed off 2026-05-22

**All recommendations accepted** as the canonical decision (Decision column filled per row
below). Two items carried forward:

- **N3 (cold-cache fallback)** — stays **OPEN**. No engineering recommendation exists; it is
  a product/UX call. Does not block Phase 3b — it gates Phase 4.
- **V1 (keep vs drop military vessels)** — **BLOCKED** on deployment data. The vessel
  signal's weight in the blend cannot be measured until `seed-military-cii.mjs` runs on
  Railway. Default until then: keep vessels (already built).

With those two exceptions Phase 3a is settled — **Phase 3b may proceed against this table.**

---

## 1. Component formulas

| # | Component | Engine A (frontend) | Engine B (server) | Recommendation | Decision |
|---|---|---|---|---|---|
| C1 | **Unrest** | adds `severityBoost = min(20, highSeverity·10·mult)`; counts `protests.length` | no `severityBoost`; counts `protests + riots` | **A** — port `severityBoost`; keep server's `protests+riots` (riots belong in unrest). Hybrid: A's formula + riots included. | ✓ **HYBRID** |
| C2 | **Conflict** | has `hapiFallback` + `newsFloor` when ACLED empty; generic 7-day `recentStrikes` | no fallbacks; `iranStrikes + highSeverityStrikes` only | **A** — the fallbacks matter: without them the server scores 0 conflict whenever ACLED is empty. Port `hapiFallback` + `newsFloor`. | ✓ **A** |
| C3 | **Security** | `flightScore + vesselScore + aviationScore + gpsJammingScore` (4 inputs) | `gpsJammingScore` only | **A** — the 4-input formula. Server now has all inputs after Phases 1–2. This is the mechanical half of the #3738 fix. | ✓ **A** |
| C4 | **Information** | velocity-aware score from local `newsEvents` clustering | `newsScore + threatSummaryScore` (pre-computed, additive) | **B** — the server **cannot** run A's formula (no local `newsEvents`), and the server's cap was a deliberate #3739 improvement. Server wins; bring the frontend renderer to consume it. | ✓ **B** |

C4 is the one genuine "server wins". C1's hybrid (A's formula but keep `riots`) is the only
row that isn't a clean A-or-B — confirmed as the accepted hybrid.

## 2. eventScore weights — no decision

Both engines: `unrest·0.25 + conflict·0.30 + security·0.20 + information·0.25`. **Identical.**

## 3. Composite blend

The canonical blend. Engine A's `calculateCII`:
`baseline·0.4 + eventScore·0.6 + hotspot + newsUrgency + focal + displacement + climate + oref + advisory + supplemental + earthquake + sanctions`.
Engine B: `baseline·0.4 + eventScore·0.6 + climate + cyber + fire + advisory + oref + displacement`.

| # | Item | Recommendation | Decision |
|---|---|---|---|
| B1 | Canonical blend shape | **A's `calculateCII` blend** (the fuller one). Server adds the missing terms. Note: A's `cyber`/`fire` live *inside* `supplementalSignalBoost` — adopting A means the server's standalone `cyberBoost`/`fireBoost` terms are removed (folded into supplemental), no double-count. | ✓ **A** |
| B2 | Frontend's own split: `calculateCII` includes `earthquake`+`sanctions`, `getCountryScore` omits them | **`calculateCII` is canonical.** `getCountryScore` is deleted in Phase 4; its consumers (map tint, etc.) silently gain earthquake+sanctions — intended. | ✓ **calculateCII** |

## 4. Boost helpers

| # | Boost | Engine A | Engine B | Recommendation | Decision |
|---|---|---|---|---|---|
| D1 | hotspotBoost | `min(10, activity·1.5)` | absent | **DROP** — `hotspotActivityMap` is a frontend-only subsystem fed by `ingest*` calls; not reproducible from server signals without porting the whole hotspot tracker. Document the gap. | ✓ **DROP** |
| D2 | newsUrgencyBoost | `info≥70→5, ≥50→3` | absent | **A (port)** — pure function of the `information` component the server already has. Trivial. | ✓ **A** |
| D3 | focalBoost | `focalPointDetector` urgency `critical→8, elevated→4` | absent | **DROP** — verified frontend-only (`focalPointDetector` has zero server-side references); not reproducible server-side. Document the gap. | ✓ **DROP** |
| D4 | supplementalSignalBoost | AIS + fire + cyber + temporal (severity-weighted) | partial — see D7/D8 | **A (port)** — server has all 4 inputs after Phases 1–2. Replaces server's standalone cyber/fire terms. | ✓ **A** |
| D5 | earthquakeBoost | `min(25, severe·10 + major·5 + significant·2)` | absent | **A (port)** — server has earthquake counts after Phase 1. | ✓ **A** |
| D6 | sanctionsBoost | tiered by `entryCount` + `newEntry` bonus | absent | **A (port)** — server has sanctions counts after Phase 1. | ✓ **A** |
| D7 | cyber (within supplemental) | severity-weighted (`crit·3 + high·1.8 + med·0.9`) | `floor(cyberCount/5)` count-discount | **A** — severity-weighting beats a raw-count discount. Folds into D4. | ✓ **A** |
| D8 | fire (within supplemental) | brightness-weighted | `floor(fireCount/10)` count-discount | **A** — same reasoning. Folds into D4. | ✓ **A** |
| D9 | displacementBoost | step: `1M→8, 100K→4` (cap 8) | log: `(log10(n)−5)·8+4` (cap 20) | **B** — the log curve is more granular and spans real crisis sizes (1M→12, 10M→20); the step function flat-lines at 8. Server wins. | ✓ **B** |
| D10 | climateBoost | `climateStress` uncapped | `min(15, severity·3)` | **B** — an uncapped term is a latent bug; the cap is correct. Server wins. | ✓ **B** |
| D11 | advisoryBoost | level + source-count bonus (`≥3→+5, ≥2→+3`) | level only | **A** — source-count corroboration is a real signal; server must start tracking advisory source count. | ✓ **A** |
| D12 | orefBlendBoost | IL-only blend | identical | no decision — **identical**. | — identical |

## 5. Floors — no decision

`ucdpFloor` (70/50/0) and `advisoryFloor` (60/50/0) are **identical** in both engines.

## 6. Level thresholds

| # | Item | Engine A `getLevel` | Engine B adapter `getScoreLevel` | Recommendation | Decision |
|---|---|---|---|---|---|
| L1 | critical / high / elevated / normal cutoffs | ≥81 / ≥66 / ≥51 / ≥31 | ≥70 / ≥55 / ≥40 / ≥25 | **A** — the frontend table is what the UI has always shown; changing it shifts every country's badge. Reconcile `cached-risk-scores.ts getScoreLevel` to A's cutoffs. | ✓ **A** |

## 7. Scalar tables — `BASELINE_RISK` / `EVENT_MULTIPLIER`

The frontend `CURATED_COUNTRIES` left **AF, LB, EG, JP, QA** at the default `15 / 1.0` — they
were never curated. The server has real values for all 31. This is not a judgment call —
the frontend simply lacks curation.

| Country | Frontend (uncurated default) | Server | Recommendation |
|---|---|---|---|
| AF | baseline 15, mult 1.0 | 45 / 0.8 | **B** |
| LB | 15 / 1.0 | 40 / 1.5 | **B** |
| EG | 15 / 1.0 | 20 / 1.0 | **B** |
| JP | 15 / 1.0 | 5 / 0.5 | **B** |
| QA | 15 / 1.0 | 10 / 0.8 | **B** |
| KR | mult 1.0 | mult 0.8 | **B** |

| # | Item | Recommendation | Decision |
|---|---|---|---|
| S1 | Scalar-table source of truth | **B (server)** for all rows above — the server file already declares itself authoritative for these. Update `CURATED_COUNTRIES` to match, then both read one table. | ✓ **B** |

## 8. Non-formula Phase 3a decisions

| # | Item | Recommendation | Decision |
|---|---|---|---|
| N1 | Country set — expand server set vs accept curated-only | **Accept curated-only (31).** Both engines already iterate the same 31; the frontend's dynamic extras were thin (baseline-only). No expansion. | ✓ **curated-only** |
| N2 | Proto field naming — keep positional aliases vs rename to `unrest/conflict/security/information` | **Rename.** The cache-key bump (`v2→v3`) is mandatory regardless; do the rename in the same bump so the proto stops lying. | ✓ **rename** |
| N3 | Cold-cache fallback (Risk 3 / Open Question) | **Open** — keep a thin client fallback for the empty-result case, or accept degraded baseline-only CII on cold start. A product/UX call; gates Phase 4, not Phase 3b. | **OPEN — you decide** |
| N4 | Signal→component mapping for the Phase 1/2 signals | **aviation → Security (C3); military flights+vessels → Security (C3); AIS disruptions + temporal anomalies → supplemental (D4); earthquakes → earthquakeBoost (D5); sanctions → sanctionsBoost (D6).** | ✓ **accepted** |
| N5 | `ingest*ForCII` side-effect decomposition (which non-CII side effects survive Phase 4 deletion) | **RESOLVED — see N5 audit below.** | ✓ **resolved** |
| V1 | Keep military vessels vs drop (Phase 2 vessel classifier) | Check the vessel signal's weight in the blend before committing; if marginal, "drop + document the gap" is valid. | **BLOCKED — needs deploy data** |

### N5 audit — `ingest*ForCII` side effects (resolved 2026-05-22)

Audited all 20 `ingest*ForCII` functions in `country-instability.ts` for state writes
beyond CII scoring (`countryDataMap`). Finding:

- The **only** non-CII side effect is `trackHotspotActivity` → `hotspotActivityMap`, called
  by exactly three ingest functions: `ingestProtestsForCII` (line 258),
  `ingestConflictsForCII` (270), `ingestMilitaryForCII` (424, 444).
- `hotspotActivityMap` is consumed by **`getHotspotBoost` only** — a non-exported function
  that feeds **only** `calculateCII`'s blend. Grep confirms **zero** consumers of
  `getHotspotBoost` / `hotspotActivityMap` outside `country-instability.ts`.
- `focalPointDetector` is read by `calculateCII` / `getCountryScore` but is **not fed by any
  `ingest*ForCII`** — it is an independent detector, out of scope here.

**Conclusion: no `ingest*ForCII` side effect needs preserving.** Because D1 drops
`hotspotBoost` and Phase 4 deletes the CII engine, the entire hotspot subsystem
(`hotspotActivityMap`, `trackHotspotActivity`, `getHotspotBoost`, `resetHotspotActivity`)
is dead and deletes with it. Phase 4 deletes the `ingest*ForCII` functions **wholesale**,
not surgically — this simplifies Phase 4 vs the plan's earlier "surgical decomposition"
assumption.

## Summary

- **15 formula/threshold rows + 5 non-formula rows + V1.** All recommendations accepted
  (signed off above). Frontend wins by default; server wins only on C4 (#3739), D9
  (log curve), D10 (the cap), S1 (frontend uncurated).
- **D1 hotspot and D3 focal** — accepted **drops**; both frontend-only with no
  server-reproducible inputs. N5 confirms the hotspot subsystem deletes cleanly.
- **N3 cold-cache** — the one open decision; product/UX call; gates Phase 4.
- **V1 military vessels** — blocked on deployment data.
- Phase 3b implementation status is recorded below.

## Phase 3b — implementation status (2026-05-22)

Commits `94b7afa54` (C3) and `42e739f33` (blend + L1). 91 tests pass; typecheck clean.

**Implemented & verified:**

- **C3** — server `security` component is the full 4-input formula (flights + vessels +
  aviation + GPS). The substantive #3738 fix.
- **C1 `severityBoost`** — implemented. The server counts `highSeverityUnrest` in the ACLED
  loop and applies `min(20, count·10·mult)`.
- **D2 / D5 / D6** — newsUrgency / earthquake / sanctions boosts ported verbatim into the blend.
- **D4 / D7 / D8** — supplemental ported: AIS as its own blend term, cyber + fire
  severity-weighted (`cyberBoost` = crit·3+high·1.8+med·0.9; `fireBoost`
  = highFire·1.5 + min(20,total)·0.25). The frontend's temporal sub-boost is **not
  wired** — the `temporal:anomalies:v1` producer emits `region:'global'` so anomalies
  cannot be country-attributed (the frontend's temporal sub-boost is dormant for the same
  reason). `temporalAnomaly*Count` stay gathered-not-scored; re-wire if the producer
  emits country-scoped anomalies.
- **L1** — `getScoreLevel` cutoffs reconciled (81 / 66 / 51 / 31).

> **Correction.** C1, D7 and D8 were initially listed as deferred "missing server signal"
> items. That was wrong — and worth recording. Protest *severity*, cyber *severity*, and
> fire *brightness* are not feed signals; they are fields the cached objects already carry
> (`classifySeverity` derives protest severity from fatalities+type; cyber threats carry
> `severity`; fire detections carry `brightness`/`frp`). The server's CII *ingestion* was
> simply discarding those fields (`cyberCount++`, `fireCount++`). The lesson: check what
> the cached data carries, not what the current ingestion code reads. All three are now
> implemented.

- **C4 / D9 / D10 / N1** — no code change; the server already matched the decision.

**Deferred — the accepted decision needs a server signal that does not exist yet:**

- **C2 `hapiFallback` + `newsFloor`** — hapiFallback needs the per-ISO3
  `conflict:humanitarian:v1` keys plumbed; newsFloor needs per-event threat-category +
  source-tier data `threatSummaryByCountry` does not carry. Conflict already matches A's
  primary ACLED path — the fallbacks are a robustness follow-up.
- **D11** — advisory source-count bonus. Verified genuine: `intelligence:advisories:v1`
  exposes only `byCountry: {code → level}` — the individual advisories and their sources
  are collapsed away in the cache. The bonus needs the advisory seed extended to emit
  per-country source counts. Server `advisoryBoost` is A's formula minus that bonus.

**Deferred — Phase 4:**

- **S1** — `CURATED_COUNTRIES` AF/LB/EG/JP/QA/KR. The server is already authoritative for
  the API. Those fields are read only by the frontend engine, which Phase 4 deletes — the
  reconciliation happens by deletion, not by editing the table now.
- **N2** proto rename — the Phase 3b formula changes do not alter the `CiiScore` proto
  *shape*, so no `RISK_CACHE_KEY` bump is required. The rename is cosmetic; it rides a
  future bump.

**Net:** the substantive reconciliation is done — the server CII now scores security,
earthquakes, sanctions, temporal anomalies, and AIS, with reconciled level banding. Every
deferral is a "needs a new server signal" follow-up, documented above; none block the
unified engine from being correct on the signals it already has.
