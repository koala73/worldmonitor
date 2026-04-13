---
status: pending
priority: p3
issue_id: 193
tags: [planning, resilience, data-source, oecd, openecon]
dependencies: []
---

# OECD OpenEcon SDMX seeding is parked until a concrete consumer exists

## Problem Statement

OpenEcon exposes the full OECD SDMX 3.0 API with no key requirement, but this
workstream should stay parked as of 2026-04-13.

Prioritization review across #3025 to #3028 set OECD integration to lowest
priority because there is no concrete in-product consumer yet and the coverage
shape conflicts with world-coverage goals.

## Findings

1. Coverage ceiling:
   most OECD datasets are a 38-member subset, so naive integration would create
   blanks or OECD-only bias in global tiles/dimensions.
2. Existing overlap with current seed stack:
   - GDP, CPI, unemployment, fiscal balances are already covered by IMF WEO
     expansions.
   - Tax revenue as percent of GDP is already seeded via IMF
     `GGR_G01_GDP_PT`.
3. No active consumer:
   `server/worldmonitor/resilience/v1/_indicator-registry.ts` has no current
   slot waiting for OECD-only education, R&D, or health share inputs.
   No current panel renders these fields.

## Proposed Solutions

### Option 1: Keep parked until consumer exists (recommended)

Do not land OECD seeders now. Keep this issue as a parking lot and only un-park
when a named panel tile or resilience dimension requires it.

**Pros:** Avoids global coverage regression and duplicate source complexity.
**Cons:** Defers potentially useful OECD-only signals.
**Effort:** None now.
**Risk:** Low.

### Option 2: Seed now and gate later

Build seeders immediately, then decide rendering behavior after.

**Pros:** Data available earlier for prototyping.
**Cons:** High risk of unused infra, blank tiles, and source duplication.
**Effort:** Medium-high.
**Risk:** Medium-high.

## Recommended Action

Keep parked.

Revisit only when a concrete consumer is named and non-OECD behavior is fully
defined.

## Technical Details

### Candidate future use-cases (trigger-based)

| OECD dataflow | Future consumer trigger |
|---|---|
| `OECD.SDD.TPS / DSD_PDB@DF_PDB_LV` (labor productivity levels) | Revisit only if a "competitiveness" resilience dimension is added |
| `OECD.STI.PIE` (R&D percent GDP) | Revisit only if an "innovation capacity" resilience dimension is added |
| `OECD.SDD.EDSTAT` (education spending percent GDP) | Revisit only if a social-investment resilience dimension is added |
| `OECD.SDD.TPS / DSD_SHA` (health expenditure) | Revisit only if `healthPublicService` expands beyond current WHO/FSI inputs |
| `OECD.ELS.SAE / DSD_HW@DF_AVG_ANN_HRS_WKD` (average hours worked) | Revisit only if a labor-market tile is introduced as an OECD-only overlay |
| Governance indicators (product market regulation, rule-of-law variants) | Prefer broader global alternatives first (for example V-Dem, WGI) |

When any OECD source is scoped:
- define explicit non-OECD behavior (hide tile, never blank tile),
- pair with a world-coverage fallback source where possible.

### SDMX implementation notes for future activation

- Base URL: `https://sdmx.oecd.org/public/rest`
- Data endpoint:
  `/data/{agency},{dsd_id}@{dataflow_id},{version}/{filter_key}?dimensionAtObservation=AllDimensions&startPeriod=2019&endPeriod=2025`
- Data Accept header:
  `application/vnd.sdmx.data+json; version=2.0.0`
- Structure endpoint:
  `/datastructure/{agency}/{dsd_id}/{version}`
- Structure Accept header:
  `application/vnd.sdmx.structure+json; version=2.0.0`
- Country format: ISO3 (`USA`, `DEU`, `GBR`)
- Aggregates include: `OECD`, `EA19`, `EU27_2020`, `G7`, `G20`
- Rate envelope: approximately `60 req/hr` per IP
- Timeout target: `50s`
- Backoff target: 3 attempts (`3s`, `6s`, `12s`) with jitter
- No auth required

Gotchas:
- Dimension `position` can be missing/unreliable; map by dimension ID.
- Filter-key ordering varies by DSD; always introspect DSD first.

Sample working query:

```bash
curl -H "Accept: application/vnd.sdmx.data+json; version=2.0.0" \
  "https://sdmx.oecd.org/public/rest/data/OECD.SDD.NAD,DSD_NAMAIN10@DF_TABLE1_EXPENDITURE,1.0/.USA..........?dimensionAtObservation=AllDimensions&startPeriod=2020&endPeriod=2025"
```

Response parse pattern:

```ts
const observations = json.data.dataSets[0].observations;
const dims = json.data.structures[0].dimensions.observation;
const timeValues = dims.find(d => d.id === 'TIME_PERIOD').values;

for (const [obsKey, obsVal] of Object.entries(observations)) {
  const indices = obsKey.split(':').map(Number);
  const timePeriod = timeValues[indices.at(-1)].id;
  const value = obsVal[0];
}
```

## Acceptance Criteria

- [ ] A specific panel tile or resilience dimension is named before any OECD seeder lands.
- [ ] Non-OECD rendering path is explicit (hidden vs blank) and does not degrade existing panels.
- [ ] A world-coverage fallback source is paired wherever feasible.

## Work Log

- 2026-04-13: parked based on #3025-#3028 reprioritization and consumer-first rule.

## Resources

- GitHub issues: #3025, #3026, #3027, #3028
- Candidate consumer touchpoint:
  `server/worldmonitor/resilience/v1/_indicator-registry.ts`
