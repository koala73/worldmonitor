# WorldMonitor chokepoint status, daily open dataset

Status: proof of concept. The license is proposed, not granted. See "License" below.

One row per maritime chokepoint per UTC day. Each row holds the disruption score, the traffic-light status, the war-risk tier, and the counts and flags that WorldMonitor computes for that chokepoint. WorldMonitor computes every value in this dataset. Raw values from third-party feeds are withheld (see "Withheld fields").

## Files

All files are served over HTTPS from `https://www.worldmonitor.app/data/v1/chokepoints/` with `Access-Control-Allow-Origin: *`. No key, no account, no rate-limit policy beyond the CDN.

| Path | Content |
|------|---------|
| `latest.json` | The newest snapshot. Same bytes as the newest dated JSON file. |
| `latest.csv` | The newest snapshot as CSV. Same bytes as the newest dated CSV file. |
| `YYYY-MM-DD.json` | The snapshot for that UTC date. Never rewritten once a later date exists. |
| `YYYY-MM-DD.csv` | The same snapshot as CSV. One header row, then one row per chokepoint. |
| `schema.json` | JSON Schema (draft 2020-12) for the JSON files. |
| `index.json` | `{ "schema_version", "dataset", "latest", "dates": [...] }`. Lists every dated file. |
| `README.md` | This file. |

Caching: `Cache-Control: public, max-age=3600` and a CDN `s-maxage` of 3600 seconds. A new snapshot is visible within one hour of deploy.

### Examples

```sh
curl -s https://www.worldmonitor.app/data/v1/chokepoints/latest.json | jq '.chokepoints[] | {id, status, disruption_score}'
curl -s https://www.worldmonitor.app/data/v1/chokepoints/index.json | jq -r '.dates[]'
curl -sO https://www.worldmonitor.app/data/v1/chokepoints/2026-09-10.csv
```

```js
const res = await fetch('https://www.worldmonitor.app/data/v1/chokepoints/latest.json');
const { snapshot_date, chokepoints } = await res.json();
```

Concatenate dated CSV files to build a time series. `snapshot_date` is the first column of every row.

## Update cadence

One snapshot per UTC day, built from the public `GetChokepointStatus` endpoint (`https://www.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status`). The generator is `scripts/build-open-data-chokepoints.mjs` in the [worldmonitor repository](https://github.com/koala73/worldmonitor). The GitHub Actions workflow `open-data-chokepoints.yml` builds the files and opens a review pull request. The daily schedule is off until the license decision below is made. Until then, files refresh only when a maintainer runs the workflow by hand.

The first dated file, `2026-09-10.json`, was built from a response captured from the production endpoint on 2026-09-10 (`source_fetched_at` in the file). It was not generated on that day.

## Schema

`schema_version` follows semantic versioning. A new column or a new enum value bumps the minor version. A removed or renamed column, a changed type, or a changed meaning bumps the major version and moves the files to a new path (`/data/v2/...`). Patch versions change descriptions only. `schema.json` is regenerated on every run from the same field table that produces the rows, so the schema and the data cannot drift apart.

`schema.json` declares `generated_at` with `format: "date-time"`. Validators that enforce formats need format support loaded (for Ajv, `ajv-formats`).

### Envelope

| Key | Type | Meaning |
|-----|------|---------|
| `schema_version` | string | `1.0.0` |
| `dataset` | string | `worldmonitor-chokepoint-status` |
| `snapshot_date` | string | UTC calendar date the snapshot represents, `YYYY-MM-DD`. |
| `generated_at` | string | ISO 8601 UTC timestamp of file generation. |
| `source_url` | string | The endpoint the snapshot was built from. |
| `source_fetched_at` | string | `fetchedAt` reported by that endpoint, that is, when WorldMonitor last rebuilt the status payload. |
| `upstream_unavailable` | boolean | True when the endpoint reported that one of its sources was unavailable for the cycle. Rows then carry nulls and false flags where data was missing. |
| `methodology_url` | string | The public methodology page for the disruption score. |
| `readme_url` | string | This file. |
| `license` | object | `{ "proposed": "CC-BY-4.0", "status": "proposed-pending-owner-decision" }` |
| `attribution` | string | The attribution line to reproduce when you redistribute. |
| `chokepoints` | array | One row per chokepoint, sorted by `id`. |

### Row

Columns appear in this order in both JSON and CSV. The CSV adds `snapshot_date` as its first column. Null is an empty CSV cell.

| Column | Type | Meaning |
|--------|------|---------|
| `id` | string | Stable WorldMonitor identifier, for example `hormuz_strait`. |
| `name` | string | Display name. |
| `lat` | number | Latitude of the reference point, decimal degrees. |
| `lon` | number | Longitude of the reference point, decimal degrees. |
| `status` | `green`, `yellow`, `red` | Badge for `disruption_score`: green below 20, yellow 20 to 49, red 50 and above. Not an operational open or closed flag. |
| `disruption_score` | integer 0 to 100 | WorldMonitor composite score. Inputs: an editorial threat baseline, the count of NGA navigational warnings, the highest AIS congestion severity, and a transit-collapse bonus from the IMF PortWatch series. |
| `war_risk_tier` | `unspecified`, `normal`, `elevated`, `high`, `critical`, `war_zone` | WorldMonitor editorial tier, informed by Lloyd's Joint War Committee listed areas and open-source reporting. |
| `congestion_level` | `normal`, `low`, `elevated`, `high`, or null | AIS-derived congestion. Null when the AIS snapshot was unavailable. |
| `active_warnings` | integer | NGA navigational warnings WorldMonitor matched to the chokepoint. |
| `ais_disruptions` | integer | AIS disruption events WorldMonitor matched to the chokepoint. |
| `navigational_warnings_available` | boolean | True when the warning source answered this cycle, including with an empty list. |
| `ais_snapshot_available` | boolean | True when the AIS snapshot answered this cycle. Governs `ais_disruptions` and `congestion_level`. |
| `transit_data_available` | boolean | True when PortWatch transit history was available. Governs `transit_wow_change_pct`. |
| `transit_today_counts_available` | boolean | True when the 24-hour AIS window held crossings. Governs the four `transit_today_*` columns. |
| `transit_today_total` | integer or null | AIS crossings in the last 24 hours, all types. |
| `transit_today_tanker` | integer or null | Tanker crossings in the last 24 hours. |
| `transit_today_cargo` | integer or null | Cargo crossings in the last 24 hours. |
| `transit_today_other` | integer or null | Other crossings in the last 24 hours. |
| `transit_wow_change_pct` | number or null | Trailing 7 days versus the prior 7 days, percent, computed by WorldMonitor over the PortWatch daily series. |
| `flow_ratio` | number or null | Latest 7-day PortWatch average over the preceding baseline window of up to 90 days, clamped to 0.0 to 1.5. Null when no flow estimate exists for that chokepoint. |
| `flow_disrupted` | boolean or null | True when each of the latest 3 daily ratios is below 85% of the baseline window. |
| `flow_source` | `portwatch-dwt`, `portwatch-counts`, or null | Basis of `flow_ratio`: deadweight tonnage when the window has it, else vessel counts. |

Chokepoints covered: Bab el-Mandeb, Bosporus Strait, Cape of Good Hope, Dover Strait, Gibraltar, Strait of Hormuz, Kerch Strait, Korea Strait, Lombok Strait, Strait of Malacca, Panama Canal, Suez Canal, Taiwan Strait. Six of them have no flow estimate, so their `flow_*` columns are null.

## Withheld fields

The endpoint returns more fields than this dataset publishes. These stay out, and the generator fails if any of them leaks:

| API field | Why it is withheld | Source |
|-----------|--------------------|--------|
| `transitSummary.incidentCount7d`, `transitSummary.disruptionPct`, `transitSummary.riskLevel` | Raw third-party values, or a banding of one third-party score. | CorridorRisk.io |
| `flowEstimate.baselineMbd`, `flowEstimate.currentMbd` | A published reference figure, and a value that reveals it. | U.S. EIA 2023 chokepoint reference levels |
| `flowEstimate.hazardAlertLevel`, `flowEstimate.hazardAlertName` | Passthrough of a third-party hazard layer. | IMF PortWatch disruptions database |
| `transitSummary.history`, `directionalDwt` | Raw daily transit counts. | IMF PortWatch |
| `transitSummary.riskSummary`, `transitSummary.riskReportAction` | Third-party prose. The endpoint already blanks both. | CorridorRisk.io |
| `description`, `affectedRoutes`, `directions` | Editorial prose and static lists, out of scope for v1. | WorldMonitor |

## License

Proposed: [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).

This proposal is pending the decision of the WorldMonitor owner. Until the owner records a decision in this file, the files carry no license grant, and the WorldMonitor [EULA](https://www.worldmonitor.app/docs/eula) and the terms of each upstream provider apply. The repository's source-attribution ledger marks every upstream on this path as "terms-review", which means WorldMonitor has not yet confirmed each provider's redistribution terms. Do not redistribute until the status line at the top of this file changes.

Both the envelope `license` object and this section change together when the decision lands.

## Attribution

Reproduce this line when you redistribute or publish derived work:

> WorldMonitor (https://www.worldmonitor.app). Scores and statuses are computed by WorldMonitor from IMF PortWatch, NGA Maritime Safety Information, and AIS data via aisstream.io.

Upstream providers whose data informs the computed values, with the links WorldMonitor's attribution ledger records:

- IMF PortWatch, https://portwatch.imf.org (daily transit series behind `transit_wow_change_pct`, `flow_*`, and the transit-collapse score input). WorldMonitor's PortWatch tooling notes that PortWatch is based on UN Global Platform AIS data.
- NGA Maritime Safety Information, https://msi.nga.mil (navigational warnings behind `active_warnings` and one score input).
- AISstream, https://aisstream.io (AIS positions behind `ais_disruptions`, `congestion_level`, and the `transit_today_*` counts).
- Lloyd's Joint War Committee listed areas and open-source reporting (editorial input to `war_risk_tier` and the threat baseline). Not fetched; maintained in the repository.

## Limitations

- `status` and `disruption_score` are WorldMonitor's own composite. They are not an official or operational closure status, and two chokepoints (Hormuz, Kerch) carry an editorial baseline of 70, so they read red even when every live input is calm.
- `war_risk_tier` and the threat baseline are editorial and reviewed by hand. The endpoint appends a review-overdue note to its prose when the baseline is older than 120 days. That prose is not in this dataset.
- When `transit_today_counts_available` is false the endpoint still reports zeros. This dataset publishes nulls instead. Do not read a null as zero crossings.
- `source_fetched_at` is when WorldMonitor last rebuilt the status payload, not when each upstream was observed. WorldMonitor reseeds the PortWatch series at least every 6 hours, caches warnings for 1 hour, and rebuilds AIS transit summaries every 10 minutes.
- Snapshots are taken once per day. Intraday changes are not recorded.
- The schedule is off in this proof of concept, so dates may be missing from `index.json`. A missing date means no snapshot, not a quiet day.
- The `/data/*` path also sends `Content-Signal: ai-train=no, search=yes, ai-input=yes`. That header is a site-wide setting and is not part of the dataset license.

## Versioning and contact

The generator, schema table, tests, and workflow live in the worldmonitor repository under `scripts/build-open-data-chokepoints.mjs`, `tests/open-data-chokepoints.test.mjs`, and `.github/workflows/open-data-chokepoints.yml`. Open an issue at https://github.com/koala73/worldmonitor/issues for schema questions or errors in a snapshot.
