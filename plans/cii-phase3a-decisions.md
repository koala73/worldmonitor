# CII Phase 3a — reconciliation decision table

Companion to `plans/unify-cii-single-source.md`. Phase 3b implements whatever this table
decides; per the plan, Phase 3b makes **no** decisions of its own.

Every row is a real divergence between the two engines, verified line-by-line:
- **Engine A — frontend**: `src/services/country-instability.ts`
- **Engine B — server**: `server/worldmonitor/intelligence/v1/get-risk-scores.ts`

Each row has a **Recommendation** (pre-filled, with rationale) and a **Decision** column
for you. Default rule from the plan: *frontend wins, except where the server intentionally
diverged.* Fill the Decision column (`A` / `B` / `new`) — blank means "accept recommendation."

Caps the score anyway: the composite is `Math.min(100, Math.max(floor, blend))` in both
engines, so individual boost caps are about *shape*, not overflow.

---

## 1. Component formulas

| # | Component | Engine A (frontend) | Engine B (server) | Recommendation | Decision |
|---|---|---|---|---|---|
| C1 | **Unrest** | adds `severityBoost = min(20, highSeverity·10·mult)`; counts `protests.length` | no `severityBoost`; counts `protests + riots` | **A** — port `severityBoost`; keep server's `protests+riots` (riots belong in unrest). Hybrid: A's formula + riots included. | |
| C2 | **Conflict** | has `hapiFallback` + `newsFloor` when ACLED empty; generic 7-day `recentStrikes` | no fallbacks; `iranStrikes + highSeverityStrikes` only | **A** — the fallbacks matter: without them the server scores 0 conflict whenever ACLED is empty. Port `hapiFallback` + `newsFloor`. | |
| C3 | **Security** | `flightScore + vesselScore + aviationScore + gpsJammingScore` (4 inputs) | `gpsJammingScore` only | **A** — the 4-input formula. Server now has all inputs after Phases 1–2. This is the mechanical half of the #3738 fix. | |
| C4 | **Information** | velocity-aware score from local `newsEvents` clustering | `newsScore + threatSummaryScore` (pre-computed, additive) | **B** — the server **cannot** run A's formula (no local `newsEvents`), and the server's cap was a deliberate #3739 improvement. Server wins; bring the frontend renderer to consume it. | |

C4 is the one genuine "server wins" — flagged in the plan. C1's hybrid (A's formula but
keep `riots`) is the only row that isn't a clean A-or-B; confirm it explicitly.

## 2. eventScore weights — no decision

Both engines: `unrest·0.25 + conflict·0.30 + security·0.20 + information·0.25`. **Identical.**

## 3. Composite blend

The canonical blend. Engine A's `calculateCII`:
`baseline·0.4 + eventScore·0.6 + hotspot + newsUrgency + focal + displacement + climate + oref + advisory + supplemental + earthquake + sanctions`.
Engine B: `baseline·0.4 + eventScore·0.6 + climate + cyber + fire + advisory + oref + displacement`.

| # | Item | Recommendation | Decision |
|---|---|---|---|
| B1 | Canonical blend shape | **A's `calculateCII` blend** (the fuller one). Server adds the missing terms. Note: A's `cyber`/`fire` live *inside* `supplementalSignalBoost` — adopting A means the server's standalone `cyberBoost`/`fireBoost` terms are removed (folded into supplemental), no double-count. | |
| B2 | Frontend's own split: `calculateCII` includes `earthquake`+`sanctions`, `getCountryScore` omits them | **`calculateCII` is canonical.** `getCountryScore` is deleted in Phase 4; its consumers (map tint, etc.) silently gain earthquake+sanctions — intended. | |

## 4. Boost helpers

| # | Boost | Engine A | Engine B | Recommendation | Decision |
|---|---|---|---|---|---|
| D1 | hotspotBoost | `min(10, activity·1.5)` | absent | **DROP** — `hotspotActivityMap` is a frontend-only subsystem fed by `ingest*` calls; not reproducible from server signals without porting the whole hotspot tracker. Document the gap. | |
| D2 | newsUrgencyBoost | `info≥70→5, ≥50→3` | absent | **A (port)** — pure function of the `information` component the server already has. Trivial. | |
| D3 | focalBoost | `focalPointDetector` urgency `critical→8, elevated→4` | absent | **DROP** — verified frontend-only (`focalPointDetector` has zero server-side references); not reproducible server-side. Document the gap. | |
| D4 | supplementalSignalBoost | AIS + fire + cyber + temporal (severity-weighted) | partial — see D7/D8 | **A (port)** — server has all 4 inputs after Phases 1–2. Replaces server's standalone cyber/fire terms. | |
| D5 | earthquakeBoost | `min(25, severe·10 + major·5 + significant·2)` | absent | **A (port)** — server has earthquake counts after Phase 1. | |
| D6 | sanctionsBoost | tiered by `entryCount` + `newEntry` bonus | absent | **A (port)** — server has sanctions counts after Phase 1. | |
| D7 | cyber (within supplemental) | severity-weighted (`crit·3 + high·1.8 + med·0.9`) | `floor(cyberCount/5)` count-discount | **A** — severity-weighting beats a raw-count discount. Folds into D4. | |
| D8 | fire (within supplemental) | brightness-weighted | `floor(fireCount/10)` count-discount | **A** — same reasoning. Folds into D4. | |
| D9 | displacementBoost | step: `1M→8, 100K→4` (cap 8) | log: `(log10(n)−5)·8+4` (cap 20) | **B** — the log curve is more granular and spans real crisis sizes (1M→12, 10M→20); the step function flat-lines at 8. Server wins. | |
| D10 | climateBoost | `climateStress` uncapped | `min(15, severity·3)` | **B** — an uncapped term is a latent bug; the cap is correct. Server wins. | |
| D11 | advisoryBoost | level + source-count bonus (`≥3→+5, ≥2→+3`) | level only | **A** — source-count corroboration is a real signal; server must start tracking advisory source count. | |
| D12 | orefBlendBoost | IL-only blend | identical | no decision — **identical**. | |

## 5. Floors — no decision

`ucdpFloor` (70/50/0) and `advisoryFloor` (60/50/0) are **identical** in both engines.

## 6. Level thresholds

| # | Item | Engine A `getLevel` | Engine B adapter `getScoreLevel` | Recommendation | Decision |
|---|---|---|---|---|---|
| L1 | critical / high / elevated / normal cutoffs | ≥81 / ≥66 / ≥51 / ≥31 | ≥70 / ≥55 / ≥40 / ≥25 | **A** — the frontend table is what the UI has always shown; changing it shifts every country's badge. Reconcile `cached-risk-scores.ts getScoreLevel` to A's cutoffs. (Override only if you want a deliberate re-banding.) | |

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
| S1 | Scalar-table source of truth | **B (server)** for all rows above — the server file already declares itself authoritative for these. Update `CURATED_COUNTRIES` to match, then both read one table. | |

## 8. Non-formula Phase 3a decisions

| # | Item | Recommendation | Decision |
|---|---|---|---|
| N1 | Country set — expand server set vs accept curated-only | **Accept curated-only (31).** Both engines already iterate the same 31; the frontend's dynamic extras were thin (baseline-only). No expansion. | |
| N2 | Proto field naming — keep positional aliases vs rename to `unrest/conflict/security/information` | **Rename.** The cache-key bump (`v2→v3`) is mandatory regardless; do the rename in the same bump so the proto stops lying. | |
| N3 | Cold-cache fallback (Risk 3 / Open Question) | **Open** — keep a thin client fallback for the empty-result case, or accept degraded baseline-only CII on cold start. Still needs your call; see the plan's Deferred section. | |
| N4 | Signal→component mapping for the Phase 1/2 signals | **aviation → Security (C3); military flights+vessels → Security (C3); AIS disruptions + temporal anomalies → supplemental (D4); earthquakes → earthquakeBoost (D5); sanctions → sanctionsBoost (D6).** Confirm. | |
| N5 | `ingest*ForCII` side-effect decomposition (which non-CII side effects survive Phase 4 deletion) | Enumerate before Phase 4: `trackHotspotActivity → hotspotActivityMap` is the known one. Produce the full list as part of this table. | |

## Summary

- **15 formula/threshold rows + 5 non-formula rows.** Of the formula rows, the default
  (frontend wins) holds for all **except**: C4 information (server — #3739), D9 displacement
  (server — better curve), D10 climate (server — has the cap), and S1 scalar tables (server
  — frontend is uncurated).
- **D1 hotspot and D3 focal** are recommended **drops** — both are frontend-only
  subsystems with no server-reproducible inputs.
- **N3 cold-cache** is the one row that genuinely cannot be pre-recommended — it's a
  product/UX call.
- Once the Decision column is filled, Phase 3b is mechanical: implement each winner, bump
  `RISK_CACHE_KEY`, land the Guardrails equality/level tests.
