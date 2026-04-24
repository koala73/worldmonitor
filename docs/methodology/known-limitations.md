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
