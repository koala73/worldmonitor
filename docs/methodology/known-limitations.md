# Known limitations — resilience scorer

Documented construct limitations, data-source edge cases, and
modeling-choice notes that aren't bugs but reviewers should know
before interpreting individual countries' scores.

Each entry names: the dimension(s) affected, the root cause, the
observable signature, and either the fix path or the reason it is
NOT being fixed.

---

## Displacement field-mapping (scoreSocialCohesion / scoreBorderSecurity / scoreStateContinuity)

**Dimensions.** `socialCohesion` (weight 0.25 of the blend),
`borderSecurity` (weight 0.35 of the blend), `stateContinuity`
(weight 0.20 of the blend).

**Source.** UNHCR Population API
(`https://api.unhcr.org/population/v1/population/`), written via
`scripts/seed-displacement-summary.mjs` into the Redis key
`displacement:summary:v1:<year>`.

**What UNHCR covers, and what it does not.** The UNHCR Population
registry tracks **four displacement categories**:

- `refugees` — people forced to flee and recognized under the 1951
  Convention / UNHCR mandate
- `asylum_seekers` — people whose claim is not yet determined
- `idps` — internally displaced persons (inside their own country)
- `stateless` — people without recognized nationality

It does **NOT** include:

- Labor migrants (covered by UN DESA International Migrant Stock /
  IOM's World Migration Report — a separate dataset)
- Student / tourist flows
- Naturalised citizens or long-settled foreign-born populations

**Field mapping audit** (static, code-side — no live-data access
used for this audit):

| Scorer field read | Seeder source | Seeder formula | Semantics |
|---|---|---|---|
| `displacement.totalDisplaced` | UNHCR `refugees + asylum_seekers + idps + stateless` summed on the **origin side** (`coo_iso`) | Line 140 of `seed-displacement-summary.mjs` | How many people from THIS country are currently displaced (origin outflow + internal) |
| `displacement.hostTotal` | UNHCR `refugees + asylum_seekers` summed on the **asylum side** (`coa_iso`) | Lines 148-150 of `seed-displacement-summary.mjs` | How many UNHCR-registered people THIS country is currently hosting |
| `displacement.refugees` / `asylumSeekers` / `idps` / `stateless` | Direct per-category copy from UNHCR rows (origin side) | Lines 136-139 | As UNHCR reports them |
| `displacement.hostRefugees` / `hostAsylumSeekers` | Direct per-category copy (asylum side) | Lines 148-149 | As UNHCR reports them |

**Finding.** The field mapping is **code-correct**. Labor migrants
are not in the UNHCR endpoint at all, so the plan's hypothesis —
"does `totalDisplaced` inadvertently include labor migrants?" — is
negative at the seeder level. Countries whose foreign-born
populations are dominated by labor migrants (GCC states, Singapore,
Malaysia) will have small `totalDisplaced` AND small `hostTotal`
under UNHCR's definition. That is the UNHCR-semantic output, not
a bug.

**Implication for the GCC cohort-audit question.** GCC countries
score high on `socialCohesion`'s displacement sub-component
(log10(0) → 0 → normalizes to 100) because UNHCR records them as
having small refugee inflows/outflows — correct per UNHCR
semantics, regardless of labor migrant stock. If the resilience
construct wants "demographic pressure from foreign-born
populations" as an indicator, that would require a SEPARATE data
source (UN DESA migrant stock) and a separate dimension — not a
change to this one.

**Modeling note — `scoreBorderSecurity` fallback chain is
effectively dead code.** The scorer reads
`hostTotal ?? totalDisplaced` at line 1412 of
`_dimension-scorers.ts`. Intent (from the surrounding comments):

- Primary (`hostTotal`): how many UNHCR-registered people this
  country hosts → direct border-security signal.
- Fallback (`totalDisplaced`): how many of this country's people
  are displaced → indirect border-security signal for
  origin-dominated countries.

**Discovered during this audit**: the fallback **does not fire in
production**, for two compounding reasons.

1. `safeNum(null)` returns `0`, not `null`. JavaScript's
   `Number(null) === 0` (while `Number(undefined) === NaN`), so
   the scorer's `safeNum` helper classifies `null` as a finite
   zero. The `??` operator only falls back on null/undefined, so
   `safeNum(null) ?? safeNum(totalDisplaced)` evaluates to `0`.
2. `scripts/seed-displacement-summary.mjs` ALWAYS writes
   `hostTotal: 0` explicitly for origin-only countries (lines
   141-144 of the seeder). There is no production shape where
   `hostTotal` is `undefined` — which is the only case `??`
   would actually fall back under.

**Observable consequence.** Origin-only countries with large
outflows but no asylum inflow — Syria (~7M displaced), Venezuela
(~6M), Afghanistan (~5M), Ukraine during peak — score `100` on
`scoreBorderSecurity`'s displacement sub-component (35% of the
dim). The actual signal is never picked up. Turkey-pattern
(large host, small origin) works correctly.

**Why not fixing this today.** A one-line change (`||` instead of
`??`, or `hostTotal > 0 ? hostTotal : totalDisplaced`) would
flip the borderSecurity score for ~6 high-outflow origin
countries by a material amount — a methodology change, not a
pure bug-fix. That belongs in a construct-decision PR with a
cohort-audit snapshot before/after, not bundled into an audit
doc PR. Opening a follow-up to decide: should borderSecurity
reflect origin-outflow pressure, host-inflow pressure, or both?

**Test pin.** `tests/resilience-displacement-field-mapping.test.mts`
pins the CURRENT behavior (Syria-pattern scores 100 on this
sub-component). A future construct decision that flips the
semantics must update that test in the same commit.

**What WOULD be a bug, if observed (not observed today).** If a
future UNHCR schema change renamed `refugees`/`idps`/etc.
without the seeder catching it, `totalDisplaced` would silently
drop to 0 across the board — presenting as "every country is a
perfect-cohesion utopia" in the rankings. Mitigation: the
existing seed-health gate in `/api/health` fails on
`displacement:summary:v1:<year>` record count < threshold, which
would trip before scores propagate. Verified by reading
`validate()` at line 216-223 of `seed-displacement-summary.mjs`.

**Follow-up audit (requires API-key access, not in scope of this
PR).** Spot-check 10 countries' raw `displacement:summary:v1:<year>`
payloads against UNHCR Refugee Data Finder
(https://www.unhcr.org/refugee-statistics/) to verify the seeder's
sum reproduces UNHCR's published figures:

- High host-pressure states: DE, TR, PK, UG, BD, CO, LB
- High origin-outflow states: SY, UA, AF, VE
- Labor-migrant-dominated states (should show small UNHCR numbers
  regardless of labor migrant stock): AE, QA, KW, SG

Write the comparison into this file as a subsection when the
spot-check runs.

**References.**

- Seeder: `scripts/seed-displacement-summary.mjs`
- Scorer reads: `server/worldmonitor/resilience/v1/_dimension-scorers.ts`
  lines 843 (`getCountryDisplacement`), 1383, 1412, 1765
- UNHCR Population API schema:
  https://api.unhcr.org/docs/population.html
- Plan reference:
  `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
  §PR 5.2

---

## foodWater scorer — construct-deterministic cohort identity (scoreFoodWater)

**Dimension.** `foodWater` (weight 1.0 in the `health-food` domain
aggregate). Reads from `resilience:static:<ISO2>` via
`readStaticCountry`. Three weighted slots:

| Slot | Source | Weight | Mapping |
|---|---|---|---|
| People in food crisis (log10) | `fao.peopleInCrisis` (HDX IPC/FSIN) | 0.45 | `normalizeLowerBetter(log10(max(1, n)), 0, 7)` |
| IPC phase number | `fao.phase` → digit extracted | 0.15 | `normalizeLowerBetter(phase, 1, 5)` |
| AQUASTAT water indicator | `aquastat.value` + `aquastat.indicator` (WB `ER.H2O.FWST.ZS`, labelled `'water stress'`) | 0.40 | `normalizeLowerBetter(value, 0, 100)` when indicator contains `stress`/`withdrawal`/`dependency`; `normalizeHigherBetter` when `availability`/`renewable`/`access` |

**What the plan's predecessor concern was.** The cohort-audit plan
observed that GCC countries all score ~53 on `foodWater` and
asked whether this was a "mystery regional default" or genuine
construct output.

**Finding — it is genuine construct output.**

1. IPC/HDX doesn't publish active food-crisis data for food-secure
   states like the GCC. `scripts/seed-resilience-static.mjs` writes
   `fao: null` (or omits the block) for those countries.
2. The scorer's `fao == null` branch imputes `IMPUTE.ipcFood` =
   `{ score: 88, certaintyCoverage: 0.7, imputationClass:
   'stable-absence' }` (see `_dimension-scorers.ts` line 135) at
   weight 0.6 for the combined peopleInCrisis+phase slot.
3. AQUASTAT for the GCC is EXTREME. WB indicator `ER.H2O.FWST.ZS`
   measures freshwater withdrawal as a % of internal renewable
   resources. Desert economies with desalination routinely exceed
   100% (Kuwait ~3200%, Bahrain ~3400%, UAE ~2080%, Qatar ~770%).
   Values > 100 clamp the sub-score to 0 under the lower-better
   normaliser against (0, 100).
4. Under the `fao: null` branch (which is what the static seeder
   emits for GCC in production) plus clamped AQUASTAT=0 at weight
   0.4, the weighted blend is:

   ```
   weightedScore = (IMPUTE.ipcFood × 0.6 + 0 × 0.4) / (0.6 + 0.4)
                 = (88 × 0.6) / 1.0
                 = 52.8  → 53
   ```

   Pinned as an anchor test in
   `tests/resilience-foodwater-field-mapping.test.mts`. Note that
   an alternative scenario — `fao` present with `peopleInCrisis: 0`
   and `phase: null` — converges on a near-identical 52.94 via the
   else branch formula `(100×0.45 + 0×0.4) / 0.85`. That convergence
   is a coincidence of the specific zero-peopleInCrisis input, NOT
   the construct's intent — the test fixture is intentionally shaped
   to exercise the IMPUTE path that matches production.

**Why GCC scores are identical across the cohort.** GCC
countries share:

- Same IPC status (not monitored → same impute constant)
- Same AQUASTAT indicator (`'water stress'`, WB's standard label)
- Extreme and similarly-clamped withdrawal ratios (all > 100 →
  all clamp to 0 on the AQUASTAT sub-score)

Identical inputs → identical outputs. That is construct
determinism, not a regional-default lookup. Pinned with a
synthetic two-country test: identical input shapes produce
identical scores; different water profiles produce different
scores.

**Regression-guard tests** in
`tests/resilience-foodwater-field-mapping.test.mts`:

- Indicator routing: `'water stress'` → lower-better;
  `'renewable water availability'` → higher-better.
- GCC extreme-withdrawal anchor: AQUASTAT value=2000 +
  `fao: null` (IMPUTE branch, matching production) blends to
  exactly 53 via `(88×0.6 + 0×0.4) / 1.0 = 52.8 → 53`.
- IPC-absent with static record present: imputes
  `ipcFood=88`; observed AQUASTAT wins →
  `imputationClass=null` per weightedBlend's T1.7 rule.
- Fully-imputed (FAO missing AND AQUASTAT missing): surfaces
  `imputationClass='stable-absence'`.
- Fully-absent static record (seeder never ran): returns
  coverage=0, NOT an impute.
- Cohort determinism: identical inputs → identical scores;
  different water-profile inputs → different scores.

**Implication — no fix required.** The scorer is producing the
construct it's specified to produce. The observed GCC identity
is a correct summary statement: "non-crisis food security +
severe water-withdrawal stress." A future construct decision
might split `foodWater` into food and water sub-dims so the
water-stress signal doesn't saturate the combined dim across
desert economies — but that is a construct redesign, not a
bug fix.

**Follow-up data-side spot-check (requires API key / Redis
access; not in scope of this PR).** Pull raw AQUASTAT + FAO
inputs for GCC + IL + JO (similar water-stressed region) and
verify the seeder-written values against WB's live API
response. If a GCC country's WB value differs substantially
from the figures above, the seeder may have a stale-year
picker bug — unlikely given `seed-resilience-static.mjs` uses
`mrv=15` + `selectLatestWorldBankByCountry`, but worth
verifying.

**References.**

- Seeder: `scripts/seed-resilience-static.mjs` lines 658-680
  (`WB_WATER_STRESS_INDICATOR`, `fetchAquastatDataset`,
  `buildAquastatWbMap`)
- Scorer reads:
  `server/worldmonitor/resilience/v1/_dimension-scorers.ts`
  lines 895 (`scoreAquastatValue`), 1471 (`scoreFoodWater`),
  135 (`IMPUTE.ipcFood` constant)
- WB indicator docs:
  https://data.worldbank.org/indicator/ER.H2O.FWST.ZS
- Plan reference:
  `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
  §PR 5.3
- Test regression guards:
  `tests/resilience-foodwater-field-mapping.test.mts`

---

## tradeSanctions → tradePolicy: OFAC-domicile component dropped (Ship 1, 2026-04-25)

**Status.** RESOLVED via plan 2026-04-25-004 Phase 1 (Ship 1). The
construct question described below — "is OFAC-designated-party domicile
count a country-resilience signal?" — was answered "no, drop it."

The dimension was renamed `tradeSanctions` → `tradePolicy` and the
OFAC `sanctionCount` component (was weight 0.45) was REMOVED. The
remaining 3 trade-policy components were reweighted to 0.30 (WTO
restrictions) + 0.30 (WTO barriers) + 0.40 (applied tariff rate). The
seeder `scripts/seed-sanctions-pressure.mjs` continues to write
`sanctions:country-counts:v1` for other consumers (country brief
generation, ad-hoc analysis); only the resilience scorer's binding was
removed.

A separate `financialSystemExposure` dim is being added in plan Phase 2
(Ship 2). It captures structural sanctions vulnerability via three
signals — BIS Locational Banking Statistics by-parent cross-border
claims, World Bank IDS short-term external debt as % of GNI, and FATF
AML/CFT listing status — none of which conflate transit-hub corporate
domicile with host-country resilience.

**Decision rationale (preserved as a methodological reference).** The
OFAC count was "how many designated parties list this country as a
location," not "how many sanctions this country is under." It mixed
three categories: country-level sanction targets (intended signal),
domiciled sanctioned entities (debatable), and transit/shell entity
listings (construct-incorrect). The third category dominated for
financial hubs (UAE, Singapore, Hong Kong, Cyprus) — UAE's −28-point
gap vs Kuwait/Qatar in the 2026-04-24 cohort audit was almost entirely
driven by Iran-evasion shell-company listings and Russian-asset SPVs.
Penalizing the host jurisdiction for shell-entity behavior conflated
financial-system openness with state policy and produced systematic
false signals for hub economies. Plan 2026-04-25-004 chose the
structurally cleanest fix — drop the component and rebuild via
audited cross-border banking + AML/CFT data — over the partial fixes
that were considered (program-weight categorization, transit-hub
exclusion lists).

**Cross-reference.** Plan 2026-04-25-004
(`docs/plans/2026-04-25-004-feat-financial-system-exposure-construct-plan.md`)
Phase 1 ships the rename + drop; Phase 2 ships the
`financialSystemExposure` dim. The earlier
`docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
§PR 5.1 captured the original construct question and its three options
(status quo / program-weight / transit-hub exclusion); plan
2026-04-25-004 supersedes it with Option 4 (drop + rebuild).

**Retired-but-not-deleted code.** `RESILIENCE_SANCTIONS_KEY` constant
and `normalizeSanctionCount` helper in
`server/worldmonitor/resilience/v1/_dimension-scorers.ts` are retained
with retire-tag comments pending Phase 2's decision on whether the OFAC
count gets re-purposed inside `financialSystemExposure`. The historical
`tests/resilience-sanctions-field-mapping.test.mts` was deleted; its
formula-pinning role is replaced by
`tests/resilience-trade-policy-formula.test.mts`, which pins the new
3-component weighted-blend contract.
