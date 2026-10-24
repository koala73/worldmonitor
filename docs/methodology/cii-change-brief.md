# CII change brief: read this before you touch CII scoring

This brief applies to `server/worldmonitor/intelligence/v1/get-risk-scores.ts`, `server/worldmonitor/intelligence/v1/_risk-config.ts`, `shared/cii-weights.ts`, any seeder or data file that the CII reads, and any change to `CII_FORMULA_VERSION`. Read all of it before you change anything.

It is the result of v9→v14: six versions in 44 hours. Each of those versions fixed the country that triggered it and missed the rule behind it. The 2026-10-23 first-principles review found that v14 is a static prior with floors on top. Live events supply about 15% of points and roughly none of the cross-country variance.

## 0. First principles: answer these in writing before you write any code

1. **What does CII measure?** Current instability on the country's own territory: armed violence there, attacks on it, civil unrest, state breakdown, repression, humanitarian shock. Strikes count for the target, never the attacker.
   - CII is not travel risk, media attention, geopolitical exposure, sanctions pressure, natural hazard, routine military posture, sensor density, or where infrastructure is hosted.
2. **Which rule produces the symptom?** "Country X looks wrong" is an observation. It is not a defect. Name the rule, for example "`max(blended, floor)` discards evidence below the floor". Then list every country that rule distorts today, using the full 31-row table from `scripts/cii-table-diff.mts`. If you can't name the rule, keep investigating. Do not change any constant.
3. **Is it the input, the aggregation, or the process?**
   - Input: it measures the wrong thing, has the wrong attribution, has the wrong window, or a dead mapping.
   - Aggregation: floors, caps, double counting, cliffs.
   - Process: no fixture, no production check.

   Fix the layer the defect sits in. More amplitude never fixes an input or aggregation defect.
4. **What would a reviewer outside this session say?** Compare against the benchmarks: GPI, FSI, INFORM, the ACLED Conflict Index and CrisisWatch direction. If your change lowers rank agreement with them, it needs a stated construct reason.

## 1. Forbidden moves (each one has already cost us a version)

- **No target for a named country.** No "SA ≥ 63", "LB should rise", or "IL should differ from BR". Pairs only enter through the ordering list in the spec, with a written rationale and no numbers.
- **No `max(score, floor)` and no stacked floors or caps.** A structural prior enters once, additively in log-odds. Above it, evidence always moves the score.
- **No scoring an input before it has a row in `docs/methodology/cii-input-register.md`.** The row records construct, attribution (victim or actor), window, coverage, normalisation, precision, its failure mode, and which family it belongs to.
- **No new amplitude to get a country past another rule.** v10 raised the cap, v11 raised it to 70, v12 added a strike floor and boost: that pattern is forbidden.
- **No fallback table that disagrees with its live source.** Missing means unknown.
- **No step functions on LLM labels or event counts.** That rules out the strike floor's 0→40 jump at P=5, the UCDP cut at 100 events, and a "moderate" vs "elevated" label moving a score by 23.
- **No regime switch with global side effects.** One ACLED row anywhere must not switch GDELT off for every country.
- **No changing the formula in a feature PR.** No renumbering a version at merge.

## 2. Required properties

`tests/cii-invariants.test.mts` measures these on every committed fixture and on synthetic scenarios. They must also hold in production after a deploy.

| # | Property | Test |
|---|---|---|
| P1 | Responds to evidence | +5 strike units, +10 on a channel, or +1 severe event raises S by ≥0.5 when S is below 95; no (country, channel) pair has Δ = 0 |
| P2 | Parity | The same evidence with the same prior gives the same Δz in every country (within k) |
| P3 | Continuity | ≤3 points per unit, no single step > 5; recovery has no cliffs; a 5-day half-life holds ±20% |
| P4 | Responsiveness | 5 units/day gives ≥ +5 in 48h and ≥ +10 in 7 days, in every country |
| P5 | Preserves information | ≤2 countries share a score to 0.1 unless their inputs are identical; no 5-point band holds > 25% of countries; 0 pairs ordered against the evidence |
| P6 | One event, one count | Each record reaches exactly one term; within a family, sources merge by deduplicated incident or by max, never by sum |
| P7 | Unknown ≠ calm | Nulling an input lowers S by no more than its decayed contribution and sets coverage below 1; a reader that maps 0 of N non-empty records is UNUSABLE, not quiet |
| P8 | Robust to a failed input | One input failing or switching to fallback moves no country by > K; an alarm fires on a provenance flip |
| P9 | Window honesty | The cache window equals the window the thresholds were calibrated on, asserted at read time |
| P10 | Normalisation | Count inputs are per-capita or per-area; more airports, ADS-B receivers, AIS stations or media volume never raise S |
| P11 | Exclusion | A's strikes on B, A's forces abroad and infrastructure hosted in A leave A unchanged |
| P12 | Noise | ±10% noise on every input: median \|ΔS\| ≤ 2, p99 ≤ 6; ×0.5–4 article volume with shares fixed moves S ≤ 1 |
| P13 | Live signal is real | ≥X% of cross-country variance comes from inputs under 30 days old; every live component has ρ > 0 against outcome data (ACLED fatalities / INFORM human hazard) |
| P14 | Explainable | prior + Σ term deltas = S within 0.5; every term is emitted; trend comes from the same latent |
| P15 | Anchors | full-scale war ≥85; chronic civil war ≥70; strike campaign on a strong state 45–65; nationwide riots in a stable democracy 35–55; quiet OECD week ≤15 |
| P16 | Benchmark agreement | ρ against the consensus (GPI/FSI/INFORM/ACLED) is ≥ 0.75 and drops by no more than 0.02 |

### How the suite measures them

The suite injects evidence into parsed sources (`buildCiiAuxiliarySources` output), so it tests the formula, not the parsers. Each test id is the property number, with a letter where one property has several checks.

- **P1.** Each channel below is added to every country on every fixture:
  - strikes: +5 weighted strike units today;
  - violence: one UCDP event yesterday with 25 deaths;
  - unrest: one nationwide internet shutdown;
  - information: 10 more high-threat headlines.

  A case fails when S rises by less than 0.5 while S is below 95.
- **P2.** Δz = logit(S′/100) − logit(S/100) for +5 strike units, with S clamped to 1–99. The range of Δz across countries must be at most **k = 0.25**.
- **P3a.** Strike units are added one at a time, up to 30. The largest step must be at most 3.
- **P3b, P3c.** A campaign of 5 units/day for 3 days, then nothing. The score is sampled every 3 hours for 8 days. No 3-hour drop may exceed 5. The campaign's contribution (score with it minus score without it) must halve in 4–6 days.
- **P5c.** "Against the evidence" means against the blend: A blends above B but scores below it.
- **P7a** nulls each input in turn. Every country whose terms change must report a coverage below 1 and below its coverage with the input present. **P7b** asks input health to call a reader that maps none of its records unusable; outages, which read `countryCode` from rows that carry only a name, are the live case.
- **P8.** Each parsed input is replaced by its empty value. For advisories that is null, which brings in the fallback table, as a failed read does. No country may move by more than **K = 10**.
- **P9** compares the span of the cached UCDP rows with the 2-year window the UCDP classes assume. It needs at least 90% of that window.
- **P10.** Ten more delayed airports per country must not raise S.
- **P11a.** A critical headline naming country A and a non-Tier-1 target (an attack abroad) must not raise A. **P11b.** +50 own military flights and +20 own vessels must not raise A.
- **P12a.** Every magnitude is scaled by a uniform factor in 0.9–1.1. That includes the scored numbers inside list records: UCDP deaths, quake magnitude, fire brightness and radiative power. Dates and locations stay fixed. Every list record is dropped or duplicated with probability 0.05 each. The run uses 40 seeded draws per fixture. **P12b.** GDELT counts and classified headline counts are scaled ×0.5, ×2 and ×4 with every share unchanged.
- **P14.** |final − blend| must be at most 0.5. The blend is baseline × 0.4 + eventScore × 0.6 + every boost.
- **P15.** Each anchor is built on an empty background with live, empty advisories.
  - Quiet week, riots and strike campaign apply to the stable OECD members DE, FR, GB, JP, KR, PL and US.
  - Chronic civil war and full-scale war apply to all 31 countries.
  - Each scenario's evidence is written in the test.
- **P6, P13, P16** are not computable from the seam and fixtures. They are listed as todos, with the reason.

**Known gaps.** `KNOWN_GAPS` in the test lists the properties the current formula fails.

- Each one runs as a node:test `todo`, and its name carries the measured value. CI stays green and the gap stays visible.
- Every other property is a real assertion.
- When a change makes a known gap pass, the ratchet test fails until the property leaves `KNOWN_GAPS`.
- A new `CII_FORMULA_VERSION` starts with no entry: its PR lists the gaps it still has, with measured values.
- Never loosen a threshold or grow the list to pass CI.

## 3. Evidence standard

### Fixtures

Replay only on the committed multi-date fixtures in `tests/fixtures/cii/`. A snapshot frozen inside your own session does not count.

- Each fixture holds trimmed production inputs and the formula's expected table for each version.
- Where it was captured, a fixture also holds the table production stored at the same moment.
- `tests/cii-fixtures.test.mts` asserts that the seam reproduces the expected table for the scored version, and production's table 31/31.
- Scores that move without a version bump fail it.

**Released tables are immutable.** A released version's expected table is a record: nothing writes or overwrites it, and the fixture test proves `--write-expected` cannot overwrite `v14`.

**An integration branch scores an unreleased version.** While `docs/methodology/cii-next.json` sets `"inProgress": true` and names the `branch`, that branch scores `next` but keeps `CII_FORMULA_VERSION` at the released version, so the single bump happens when the branch merges to main. Meanwhile:

- the scored version is `next`. The seam must reproduce `expected[next]`, and `KNOWN_GAPS[next]` in `tests/cii-invariants.test.mts` lists the gaps;
- `--write-expected` writes, or overwrites, only `expected[next]`. Every PR on the branch regenerates it after each rebase, and only through `--write-expected`;
- the production check stays as provenance. Each stored production table must equal `expected[methodologyVersion]`, the table recorded at that version. Only the seam-against-production assertion is skipped, with a message, because the tree no longer runs the released scorer. It runs again once `next` ships and is captured;
- capture fixtures from a released checkout (main). `scripts/cii-capture-fixture.mts` refuses to run on the branch, then the branch records `next` with `--write-expected`;
- the protocol snapshot in `tests/cii-scoring.test.mts` follows the same rule. It covers every literal in `computeCIIScores` and the guarded constants. The test checks the current snapshot against `CII_PROTOCOL_SNAPSHOT_HASH_BY_VERSION[next]`. A digest pins every released entry, so editing the `v14` hash fails CI. Regenerate the `next` entry only from the hash this command prints, and say in the PR body that the hash changed:

  ```
  node --import tsx --test --test-name-pattern="snapshot-keyed" tests/cii-scoring.test.mts | grep "CII protocol snapshot hash"
  ```

The PR that ships `next` to main bumps `CII_FORMULA_VERSION`, clears `inProgress`, and moves the claim on (section 4). It also freezes the `next` hash as released, by updating `CII_RELEASED_PROTOCOL_HASHES_SHA256`.

**The release gate for merging an integration branch into main.** Without it, the branch could reach main with `inProgress` still set and no version bump. Production would then serve the new scores under the old version's label, and every fixture check would stay green. The "CII release gate" tests in `tests/cii-invariants.test.mts` enforce it:

- In CI on main, on a PR into main, or in a merge-queue run for main, `inProgress` must not be set. Those runs are detected from `GITHUB_BASE_REF` and `GITHUB_REF`. Elsewhere, including local runs, the test is skipped with a message.
- Wherever `inProgress` is unset, the tree must name its own version. `CII_FORMULA_VERSION` must equal `next`, or the claim must have moved on to the version after it. `KNOWN_GAPS[CII_FORMULA_VERSION]` must exist.
- The integration branch's release-blocker list must be empty. Its assertion joins this gate in the PR that adds the list.

Capture a new fixture GET-only, with no Redis writes:

```
WM_SEED_ENV_FILE=/path/to/.env.local node --import tsx scripts/cii-capture-fixture.mts --wait-for-rebuild
```

`--wait-for-rebuild` polls the stored table and reads the inputs the moment production rebuilds it. A table minutes old no longer matches inputs that have since moved.

The capture also trims. It keeps only the fields the scorer reads and only rows that can reach a Tier-1 country. Strike-feed events keep severity, time and resolved country, with no text, source or channel; interceptions and ships at sea, which the scorer skips, are dropped. Headlines are replaced by a country name or dropped. The script then proves the trim leaves every term and every input-health state unchanged.

### Whole-table diff

Paste the output of `node --import tsx scripts/cii-table-diff.mts --base origin/main` into the PR. For every country on every fixture, it lists the blend, the binding floor, the final score and Δ final. Each fixture's footer gives:

- the floor-lifted count;
- distinct scores;
- pairs ordered against the blend;
- the count of countries moved by ≥3;
- Spearman ρ between base and head.

Every country that moves by ≥3 needs an entry in `docs/methodology/cii-changes/<version>.json`, naming the property or input that caused the move.

A new formula version records its expected tables with `--write-expected`. The script refuses to overwrite a released version's table; only an in-progress `next` table is regenerated.

### Sensitivity

For each new constant, report the range over which every property still holds. A constant chosen because it lands a country on a number is a target. Treat it as one.

### Replay is a prediction

Nothing counts as live until production matches. Capture a fixture with `--wait-for-rebuild` 4 hours and 24 hours after the deploy, and confirm that `tests/cii-fixtures.test.mts` reproduces the stored table 31/31. Watch provenance and per-input health on `seed-meta:intelligence:risk-scores`, not only the scores.

## 4. Process

- **Claim the version first.** Claim it in `docs/methodology/cii-next.json`, in the PR that starts the work:

  ```json
  { "next": "v15", "claimedBy": "<branch or PR>", "claimedAt": "<ISO time>" }
  ```

  If another PR already holds the claim, stop and coordinate. When the version ships, the merging PR moves `next` one version on and clears the claim (`claimedBy: null`). `tests/cii-docs-drift.test.mts` checks that `next` is newer than `CII_FORMULA_VERSION`.
- **Release cadence.** Soak for ≥72h after the last bump. Additive changes ship on a 14-day train. Removing a wrong-construct or dead input may use the fast lane, but still needs the suite, the diff and the production check.
- **Independent methodology review.** It comes from a reviewer who neither wrote nor tuned the change, ideally a different model family, using this brief. Bot code review does not count. One session may not author more than one consecutive version.

## 5. Failure patterns already paid for

- SA, then LB, as the target country.
- Floors deferred in four PR bodies.
- A whole-table diff with no pass/fail rule.
- Three versions in 4 hours, each "not verified in production".
- Cyber scored for 7.5 months, own military flights for 5, outages dead since #989.
- Two PRs claiming v12.
- An advisory fallback flip that moved QA by −42 without an alarm.
- A UCDP cache of 5 weeks scored against 2-year thresholds.
- A "confirmed" strike feed that was half retrospective reposts.
- Version churn that blanked the trend label and the movers for about 68 hours.

## The harness

| Piece | Path |
|---|---|
| Scoring seam | `computeCiiScoreTable(raw, { nowMs, iranEventsEnabled })` in `get-risk-scores.ts`. It is pure: no Redis, no clock, no environment. It returns every term, floor candidate and binding floor per country. Production builds call the same `buildCiiAuxiliarySources` and `computeCIIScores`. |
| Fixtures | `tests/fixtures/cii/*.json`, loaded and trimmed by `scripts/lib/cii-fixtures.mts` |
| Capture | `scripts/cii-capture-fixture.mts` |
| Whole-table diff | `scripts/cii-table-diff.mts` |
| Regression and production proof | `tests/cii-fixtures.test.mts` |
| Properties | `tests/cii-invariants.test.mts` |
| Input register | `docs/methodology/cii-input-register.md` |
| Version claim | `docs/methodology/cii-next.json` |
