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

## tradeSanctions — "designated-party domicile" construct question (scoreTradeSanctions)

**Dimension.** `tradeSanctions` (`scoreTradeSanctions`, weight 0.45
of the blend for the sanctions sub-component; 1.0 for the dim in
the `economic` domain).

**Source.** `sanctions:country-counts:v1`, a flat `ISO2 → count`
map written by `scripts/seed-sanctions-pressure.mjs`. The seeder
parses OFAC's Advanced XML (SDN + Consolidated lists), extracts
each designated party's `Locations`, and increments
`map[countryCode]` by 1 for every country listed in that
party's locations.

### What the count ACTUALLY represents

The count is **"how many OFAC-designated parties list this
country as a location"** — not "how many sanctions this country
is under." A single designated entity's primary country gets +1;
a shell that's domiciled in country X but operates via country Y
will typically list both and increment both counts.

Consequence: the count conflates three semantically distinct
categories that a resilience construct might want to treat
differently.

| Category | Example | Current scorer impact | Construct question |
|---|---|---|---|
| (a) **Country-level sanction target** | North Korea SDN listings | +1 per designated entity/person inside the sanctioned state | Penalizing the state is the INTENDED signal — resilience is genuinely degraded by comprehensive sanctions |
| (b) **Domiciled sanctioned entity** | Russian bank HQ'd in Moscow, designated post-2022 invasion | +1 per listing | The country's resilience is indirectly penalized for hosting the sanctioned actor — debatable |
| (c) **Transit / shell entity listing** | UAE-based trading company designated under SDGT for Iran oil smuggling; Cyprus-registered SPV facilitating a Russian oligarch's asset transfer | +1 per listing even when the country itself is NOT the sanctions target | The country is penalized because it's a financial hub that shell entities incorporate in — construct-debatable |

### Observed effect in the 2026-04-24 cohort audit

| Country | `tradeSanctions` dim score | Interpretation under current construct |
|---|---|---|
| KW | 82 | Low designated-party count (mostly a clean jurisdiction) |
| QA | 82 | Low count |
| AE | 54 | High count — dominated by category (c): Iran-evasion shell entities, Russian-asset SPVs |
| SA | (similar) | Low count |

AE's gap of −28 vs KW/QA is almost entirely driven by category
(c) listings. Under the CURRENT scorer, AE's resilience is
penalized for being a financial hub where sanctioned parties
incorporate shells — regardless of whether the UAE state is
complicit or targeted by the listing.

### Construct options (not decided here)

This PR deliberately does NOT pick an option; the scoring
implication is large enough that the decision belongs to a
separate construct-discussion PR with cohort snapshots.

**Option 1 — Keep the current flat count (status quo).**

- Rationale: financial-sanctions exposure IS a real resilience
  risk even for transit-hub jurisdictions. A country that
  functions as a shell-entity jurisdiction ends up correlated
  with secondary-sanctions enforcement actions, correspondent-
  banking isolation, and FATF grey-listing pressure.
- Cost: countries whose domestic policy is NOT what earned them
  the count (UAE-on-Iran, Cyprus-on-Russia) carry a score
  penalty for the behavior of entities that happen to have
  listed addresses there.

**Option 2 — Weight by OFAC program category.**

- Rationale: programs encode the nature of the designation.
  `DPRK`, `IRAN`, `SYRIA`, `VENEZUELA`, `CUBA` are
  country-comprehensive; `SDGT`, `SDNTK`, `CYBER`, `RUSSIA-EO`,
  `GLOMAG` are typically entity-specific.
- Approach: weight category-(a) programs at 1.0 and category-
  (c)-ish programs at 0.3–0.5 based on a named mapping.
- Cost: requires maintaining a program→category manifest;
  program codes change over time; currently the seeder already
  captures `programs` per entry (see
  `scripts/seed-sanctions-pressure.mjs` lines 95-108) — the
  data is there, the scorer just doesn't read it.

**Option 3 — Exclude transit-hub jurisdictions from the
domicile-count signal.**

- Rationale: a small number of jurisdictions (AE, SG, HK, CY,
  VG, KY) account for a disproportionate share of shell-entity
  listings. A hardcoded exclusion list would remove the
  category-(c) bias for those jurisdictions specifically.
- Cost: hardcoded list is brittle + normative — who gets on it
  decides who "wins" the scoring change.

### Recommendation

**Option 2** is the most defensible methodology change and is
also the only one that requires data already being collected.
The seeder captures `programs` per entry; a scorer update
would read `sanctions:program-pressure:v1` or an extended
`country-counts:v2` with per-program breakdowns and apply a
rubric-mapped weight to each program.

**This PR does NOT implement Option 2.** It:

1. Documents the three categories explicitly (above)
2. Pins the CURRENT `normalizeSanctionCount` piecewise scale
   with regression tests so a future scorer refactor cannot
   silently flip the behavior
3. Flags the construct question for a methodology-decision PR

### Follow-up audit (requires API key / Redis access)

Per the plan's §PR 5.1 task list, an entity-level sample audit
of the raw OFAC data would classify 10 entries per country
for AE, HK, SG, CY, TR, RU, IR, US into categories (a)/(b)/(c)
and produce a calibration point for an Option-2 program-weight
mapping. Out of scope for this doc-only PR.

### Regression-guard tests

Pinned in
`tests/resilience-sanctions-field-mapping.test.mts`:

- `normalizeSanctionCount` piecewise anchors:
  `count=0 → 100`, `count=1 → 90`, `count=10 → 75`,
  `count=50 → 50`, `count=200 → 25`, `count=500 → ≤ 0`.
- Monotonicity: more designated parties → lower score.
- Scorer reads `sanctions:country-counts:v1[ISO2]` and defaults
  to 0 (score=100) when the country is absent from the map —
  intentional, since absence means "no designated parties
  located here," not "data missing."
- `sanctionsRaw == null` (seed outage) → null score slot,
  NOT imputed — protects against silent data-outage scoring.

**References.**

- Seeder: `scripts/seed-sanctions-pressure.mjs` lines 83-93
  (`buildCountryCounts`)
- Scorer: `server/worldmonitor/resilience/v1/_dimension-scorers.ts`
  lines 263 (`RESILIENCE_SANCTIONS_KEY`),
  535 (`normalizeSanctionCount`), 1057 (`scoreTradeSanctions`)
- OFAC SDN docs: https://ofac.treasury.gov/specially-designated-nationals-and-blocked-persons-list-sdn-human-readable-lists
- Plan reference:
  `docs/plans/2026-04-24-002-fix-resilience-cohort-ranking-structural-audit-plan.md`
  §PR 5.1
- Test regression guards:
  `tests/resilience-sanctions-field-mapping.test.mts`
