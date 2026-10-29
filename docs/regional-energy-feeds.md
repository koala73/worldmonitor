# Regional energy feeds

`get-country-energy-profile?country_code=BD` now includes `regionalEnergyFeeds`.
The same field serves NG, ZA, AR, GE and BR. Other countries return an empty
list. Existing energy fields keep their meaning. No card or import-risk score
is added.

| Source | Country | Observations | Poll interval |
| --- | --- | --- | --- |
| PGCB | BD | Hourly generation by fuel; India and Nepal imports (MW) | 1 hour |
| Petrobangla | BD | Daily total gas, regasified LNG (MMcfd), LNG share of supply (%) | 1 day |
| NISO | NG | Dated daily peak (MW), generated/sent-out energy (MWh), frequency at peak (Hz) | 6 hours |
| Eskom | ZA | Hourly contracted demand and renewable generation (MW); weekly average unplanned outages (MW) | 1 day |
| CAMMESA | AR | National SADI actual demand, supply, fuel generation and imports (MW) | 1 hour |
| GSE | GE | Monthly generation, consumption and signed net exchange by border (GWh) | 1 day |
| ONS | BR | National SIN load, generation by fuel and signed interchange (MW) | 12 hours |
| ANP | BR | Monthly petroleum-product imports/exports (m3); national weekly retail prices, preserving each product's unit | 1 day |

These are bounded source slices, not a mirror of every provider dataset. PGCB's
demand and load-shedding cells are commented out in the source and are omitted.
NISO's hourly GenCo details, CAMMESA regional/marginal-cost data and ONS plant
and reservoir datasets are outside this initial path.

Each feed includes provider attribution, licence text, artifact URLs, fetch time,
source observation time and up to eight observations per metric/area series.
The API returns fetch and observation instants as Unix epoch milliseconds, or
zero when unavailable. Reporting periods retain their source calendar format.
Licences remain unconfirmed where no data licence was established. Public access
does not establish reuse rights. The registry is
`scripts/shared/regional-energy-feeds.json`.

Observations retain source dates and units. Zero is an observed value; missing
data has no observation. Eskom zero demand and entirely zero renewable rows are
placeholders; solar zeroes alongside observed generation are retained. Signed
exchange is retained without a risk label. Monthly periods use month end for
age checks; daily periods use the source calendar day. Hourly periods use UTC.

Feed status is `available`, `partial`, `stale`, `unavailable` (no seed) or `error`.
Fresh fetch time cannot make old observations current. Status uses the latest
observation in each series; individual observations also carry `stale`.
ANP weekly prices and Eskom weekly outages have 21-day content budgets. Other
budgets are in the registry. Optional feed failures do not discard peer feeds or
the existing profile. Core profile-cache failures retain their existing HTTP 503.

## Collection and activation

Each `scripts/seed-regional-energy-<id>.mjs` supports `--dry-run`. This fetches and
parses public sources without loading credentials or writing Redis. Normal runs
use the standard seed envelope, content metadata, lock and last-good retention
under `energy:regional:<id>:v1`, with metadata
`seed-meta:energy:regional-<id>`. Health registers these as standalone keys.
After canonical data and freshness metadata publish, the worker sets a durable
`seed-activated:energy:regional-<id>` marker without a TTL. Before that first
publication, health treats the absent key as on-demand. After activation,
missing or stale data stays strict, even after its cache TTL expires.
The MCP headline energy tool does not yet expose the regional series; the
omission is recorded in its parity exclusions.

Two isolated bundles own the writers. `seed-bundle-regional-energy-grid` runs
PGCB, NISO, CAMMESA and ONS. `seed-bundle-regional-energy-reports` runs
Petrobangla, Eskom, GSE and ANP. Both registry targets are hourly at minute 30;
members retain their individual interval gates. Each bundle has a 570-second
budget and four 120-second child deadlines. Including the runner's ten-second
termination grace per child and twenty-second preflight, all four fit in 540
seconds, even when every source times out. The child fetch phase has an
80-second deadline, leaving forty seconds for publication and cleanup.
Slow or failed sources retain last-good data without blocking later feeds. After
an authorized rollout, confirm the actual Railway schedule and image commit,
then observe two natural hourly runs and at least one daily run. Check logs for
`Regional-Energy-` and `regional-`, health metadata/record counts, and the profile
for each of BD, NG, ZA, AR, GE and BR. Require source-dated values and valid
attribution; do not count a green build or a fresh fetch alone as acceptance.
Monthly feeds need a later natural publication to prove report rollover.

On repeated HTTP/parser failures or non-advancing observations, retain last-good
data, inspect the linked provider artifact, and mark the rollout unaccepted.
The deploying operator owns validation. Roll back the regional bundle images
and schedules if their publication fails. Do not clear caches to conceal failures.

## Bangladesh certificate chains

On 2026-10-29 both Bangladesh hosts omitted an intermediate certificate. The
host-scoped undici agents add the public issuing intermediate to Node's normal
trust store. Certificate and hostname verification remain enabled. No private
key, new root CA or global TLS override is used.

The PEM files were obtained from the leaf certificates' Authority Information
Access URLs:

- `http://crt.sectigo.com/SSL2BUYEMEARSADomainValidationSecureServerCA.crt` (PGCB).
- `http://crt.sectigo.com/SectigoPublicServerAuthenticationCADVR36.crt` (Petrobangla).

Their issuer signatures were verified against Node's bundled root CAs before
use, independently of the download transport. Regression tests pin fingerprints
and verify the same signatures. If a provider changes issuer, inspect the new
chain and replace the public intermediate only after verification.
