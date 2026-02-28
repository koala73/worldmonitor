# OpenSens DAMD — Data Source Registry

| Source | Endpoint(s) | License / Terms | Caching TTL | Fallback |
|---|---|---|---|---|
| **Open-Meteo** | `/api/opensens/weather`, `/api/opensens/wind` | [CC-BY 4.0](https://open-meteo.com/en/terms) — free, no API key | 1 800 s (30 min) | None; 502 returned |
| **PVGIS v5.2 (EU JRC)** | `/api/opensens/pv` | [EUPL](https://re.jrc.ec.europa.eu/pvg_tools/en/) — free for research; results must cite JRC/PVGIS | 86 400 s (24 h) per 0.1° bucket | Clear-sky fallback model ±30%; labeled as `low` confidence |
| **OpenAQ v3** | `/api/opensens/air` | [CC-BY 4.0](https://openaq.org/about/licenses/) — free, no API key for standard usage | 900 s (15 min) | `null` AQI values returned with warning |
| **OSRM (project-osrm.org)** | `/api/opensens/routing` | BSD-2; [OpenStreetMap ODbL](https://www.openstreetmap.org/copyright) | 86 400 s (24 h) | Haversine × slack_factor; labeled `haversine-fallback` |
| **GDELT Project** | `connectors/gdelt.js` | Free for non-commercial research — [ToU](https://www.gdeltproject.org/about.html#termsofuse) | 3 600 s (1 h) | Empty signal returned |
| **Mastodon (public API)** | `connectors/mastodon.js` | AGPL-3.0 (software); public posts accessible per instance ToS | 3 600 s (1 h) | Skip unavailable instances |
| **Reddit API v2** | `connectors/reddit-stub.js` | [Reddit API ToS](https://www.redditinc.com/policies/data-api-terms) — OAuth2 required; rate 100 req/15 min | 3 600 s | Disabled stub; returns empty signal |
| **X (Twitter) API v2** | `connectors/x-stub.js` | [X Dev ToS](https://developer.x.com/en/developer-terms/agreement-and-policy) — Bearer token + paid plan required | 3 600 s | Disabled stub; returns empty signal |
| **ISP Country Priors** | `/api/opensens/connectivity` | Indicative from [Speedtest Global Index](https://www.speedtest.net/global-index) + ITU | 2 592 000 s (30 d) | Global default fallback |
| **Starlink pricing** | `/api/opensens/connectivity` | [SpaceX public pricing](https://www.starlink.com/service-plans) — $120/mo Residential (2025); verify locally | 2 592 000 s (30 d) | User override |

## Citation Requirements

| Source | Required Citation |
|---|---|
| PVGIS | Huld T., Müller R., Gambardella A. (2012). *A new solar radiation database for estimating PV performance in Europe and Africa*. Solar Energy 86, 1803–1815. |
| Open-Meteo | Open-Meteo.com, [CC-BY 4.0](https://open-meteo.com/en/terms) |
| OpenAQ | OpenAQ.org, [CC-BY 4.0](https://openaq.org/about/licenses/) |
| OSRM / OpenStreetMap | © OpenStreetMap contributors, [ODbL](https://www.openstreetmap.org/copyright) |
| GDELT | Leetaru & Schrodt (2013). GDELT: Global Data on Events, Language, and Tone. ISA Annual Convention. |

## Safe Mode Defaults

The following connectors are **DISABLED** by default and require explicit user opt-in AND valid API credentials:

- Reddit API (requires OAuth2 app + `REDDIT_CLIENT_ID` + `REDDIT_CLIENT_SECRET`)
- X API (requires paid plan + `OPENSENS_X_BEARER_TOKEN`)

Setting `OPENSENS_SAFE_MODE=1` (default) disables all gated connectors at the server level, even if credentials are present.
