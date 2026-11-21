# WorldMonitor chokepoint status, daily open dataset

License: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Use it, redistribute it, build on it, and credit WorldMonitor. See "License" below.

One row per maritime chokepoint per UTC day. Each row holds the disruption score, the traffic-light status, the war-risk tier, and the counts and flags that WorldMonitor computes for that chokepoint. WorldMonitor computes every value in this dataset. Raw values from third-party feeds are withheld (see "Withheld fields").

## Files

All files are served over HTTPS from `https://www.worldmonitor.app/data/v1/chokepoints/` with `Access-Control-Allow-Origin: *`. No key, no account, no rate-limit policy beyond the CDN.

| Path | Content |
|------|---------|
| `latest.json` | The newest snapshot. Same bytes as the newest dated JSON file. |
| `latest.csv` | The newest snapshot as CSV. Same bytes as the newest dated CSV file. |
| `YYYY-MM-DD.json` | The snapshot for that UTC date. Never rewritten once a later date exists; the generator refuses to. |
| `YYYY-MM-DD.csv` | The same snapshot as CSV. One header row, then one row per chokepoint. |
| `schema.json` | JSON Schema (draft 2020-12) for the JSON files. |
| `index.json` | `{ "schema_version", "dataset", "latest", "dates": [...] }`. Lists every dated file. |
| `README.md` | This file. |

Caching: `Cache-Control: public, max-age=3600` and a CDN `s-maxage` of 3600 seconds with `stale-while-revalidate=600`. A new snapshot is visible within 70 minutes of publication: up to an hour of CDN freshness, then up to 10 minutes of stale service while the CDN revalidates. Browsers inherit the response `Age`, so they do not add another hour on top.

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

Concatenate dated CSV files to build a time series. Every file starts with the same header row, so keep the first file's header and drop it from the rest (`tail -n +2`). `snapshot_date` is the first column of every row.

## Update cadence

One snapshot per UTC day, built from the public `GetChokepointStatus` endpoint (`https://www.worldmonitor.app/api/supply-chain/v1/get-chokepoint-status`). The generator is `scripts/build-open-data-chokepoints.mjs` in the [worldmonitor repository](https://github.com/koala73/worldmonitor). The GitHub Actions workflow `open-data-chokepoints.yml` runs daily at 06:23 UTC, builds that day's files, and publishes them to the WorldMonitor open-data archive, which serves every path below `/data/v1/chokepoints/` except `README.md` and `schema.json`. No pull request or deploy sits in between. A day whose run failed has no dated file, and the WorldMonitor health endpoint alarms after 48 hours without a publish.

The first dated file, `2026-09-10.json`, was built from a response captured from the production endpoint on 2026-09-10 (`source_fetched_at` in the file). It was not generated on that day. `2026-10-14.json` and `2026-11-02.json` were built while the dataset was still a proof of concept; `generated_at` in each file is when it was built.

## Schema

`schema_version` follows semantic versioning. A new column or a new enum value bumps the minor version. A removed or renamed column, a changed type, or a changed meaning bumps the major version and moves the files to a new path (`/data/v2/...`). Patch versions change descriptions only. `schema.json` is built from the same field table that produces the rows, and a test fails when the committed copy differs from it, so the schema and the data cannot drift apart.

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
| `license` | object | `{ "spdx": "CC-BY-4.0", "url": "https://creativecommons.org/licenses/by/4.0/" }` |
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
| `transitSummary.officialLatestTotal`, `transitSummary.officialAvg7d`, `transitSummary.baselineAvgDaily` | PortWatch's own published daily count, its 7-day mean, and its 12-month baseline mean. | IMF PortWatch |
| `transitSummary.officialLatestDate`, `transitSummary.baselineFrom`, `transitSummary.baselineTo` | Dates that describe only the three withheld PortWatch figures. | IMF PortWatch |
| `transitSummary.riskSummary`, `transitSummary.riskReportAction` | Third-party prose. The endpoint already blanks both. | CorridorRisk.io |
| `description`, `affectedRoutes`, `directions` | Editorial prose and static lists, out of scope for v1. | WorldMonitor |

## License

The files under `/data/v1/chokepoints/` are published under the [Creative Commons Attribution 4.0 International license (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). You may copy, redistribute, transform, and build on them for any purpose, including commercially, as long as you credit WorldMonitor as described under "Attribution" and note any changes you made.

The license covers the values WorldMonitor computes and publishes here. It does not relicense the upstream feeds listed under "Attribution"; raw third-party values stay out of the files (see "Withheld fields"), and anyone who goes to those providers directly is bound by those providers' terms. The license is also separate from the WorldMonitor [EULA](https://www.worldmonitor.app/docs/eula), which governs the application and its API rather than these files.

Every JSON file carries the same grant in its `license` object, and `schema.json` pins that object to `CC-BY-4.0`, so a file whose license differs fails validation.

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
- Dates can be missing from `index.json`: the first two snapshots predate the daily schedule, and a day whose daily run failed has no file. A missing date means no snapshot, not a quiet day.
- The `/data/*` path also sends `Content-Signal: ai-train=yes, search=yes, ai-input=yes`. That is the site-wide setting; it agrees with the license here, and training on these files is allowed under the same attribution terms.

## Versioning and contact

The generator, schema table, tests, and workflow live in the worldmonitor repository under `scripts/build-open-data-chokepoints.mjs`, `tests/open-data-chokepoints.test.mjs`, and `.github/workflows/open-data-chokepoints.yml`. Open an issue at https://github.com/koala73/worldmonitor/issues for schema questions or errors in a snapshot.
