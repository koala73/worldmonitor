# Upstream archive inventory for a WorldMonitor history lake

Research date: 2026-10-10. Web research only. Every claim has a URL. "Not found" means I could not confirm the fact from a primary or credible source. "Probed" means I sent a live GET from this machine on 2026-10-10 and report what came back.

Licence flags that matter for a commercial product (WorldMonitor sells Pro tiers):
- **Non-commercial or research-only:** Cloudflare Radar (CC BY-NC 4.0), OpenSky (non-profit research), ADS-B Exchange free samples (commercial use needs a licence), EM-DAT (commercial use needs a paid annual licence), abuse.ch (not-for-profit unless you pay or contribute), Yahoo (no commercial use without permission), GFW (non-commercial).
- **Open with attribution:** UCDP (CC BY 4.0), UNHCR (CC BY 4.0), ERA5 (CC BY 4.0 since 2025-07-02), IMF PortWatch (IMF data terms), GDACS, GDELT (unrestricted use), Wikidata (CC0), US federal (EIA, USGS, NASA FIRMS, NWS, OFAC; public domain or open).

## Summary table

| Source | Start | Granularity | Bulk access | Licence | Revisions | Cost |
|---|---|---|---|---|---|---|
| UCDP GED | 1989 | event, daily date | CSV/Excel download; API (token, 5,000 req/day) | CC BY 4.0 | Annual re-release (v26.1 covers 1989–2025); past events recoded; each version kept in API | Free |
| UCDP Candidate | 2011 (per downloads page) | event, monthly release | CSV per monthly version; API | CC BY 4.0 | Superseded by next GED; each monthly version addressable (`26.0.8`) | Free |
| GDELT 1.0 Events | 1979 | event; yearly files to 2005, monthly 2006–Mar 2013, daily from 2013-04-01 | HTTP zip files; BigQuery | Unrestricted, any use | Append-only, no revision process found | Free (BigQuery scans billed) |
| GDELT 2.0 Events/Mentions/GKG | 2015-02-18 23:00 UTC (probed) | 15-min files | `masterfilelist.txt` + zips; BigQuery partitioned tables | Unrestricted, any use | Append-only; no revision process documented | Free download; BigQuery $6.25/TiB scanned after 1 TiB/mo free |
| GDELT DOC 2.0 API | 2017-01-01 (timeline modes) | 15-min to daily timelines | API only; article lists limited to the last 3 months of the window | Same as GDELT | n/a | Free |
| VIEWS forecasts | Runs from 2021 (`escwa_2021_*`, `fatalities001_*`) | country-month, PRIO-GRID-month | REST API; each monthly run addressable by name; CSV | Not found | Each run is immutable, so as-of forecasts are available | Free |
| Wikipedia Current Events / Wikidata | ~2002–2003 (WCEP archives) | daily pages | Wikimedia dumps; MediaWiki API | Wikidata CC0; Wikipedia text CC BY-SA | Pages are edited after the fact; full revision history kept, so any as-of state can be rebuilt | Free |
| Powell & Thyne coups | 1950 | event (day) | CSV/Excel/TXT | Not found (academic, citation requested) | Rolling updates; dated archive of previous versions | Free |
| Archigos | 1875–2015 (v4.1) | leader spells | Stata/CSV download | Not found | Frozen at v4.1 (ends 2015-12-31) | Free |
| REIGN | 1950s–Aug 2021 | country-month | CSV on GitHub | Repo MIT; data licence not found | **Discontinued**: last data file `REIGN_2021_8.csv` | Free |
| IMF PortWatch chokepoints | 2018-12-01 (AIS archive) | daily, 28 chokepoints | ArcGIS FeatureServer (paginated) | IMF data terms (attribution, commercial OK) | Not found (estimates are model-based) | Free |
| IMF PortWatch ports | 2019 (not confirmed per port) | daily, ~1,800 ports | ArcGIS FeatureServer; CSV | IMF data terms | Not found | Free |
| UNCTAD port calls | Annual/semi-annual series (MarineTraffic-based) | country-semester/year | UNCTADstat downloads | Not found | Not found | Free |
| Commercial AIS history | Varies | position-level | Vendor contracts | Commercial | n/a | MarineTraffic Enterprise (5-year track history) is quote-only; Datalastic €199–679/mo |
| gpsjam.org | 2022-02-14 (probed) | daily, H3 res-4 hex | `gpsjam.org/data/YYYY-MM-DD-h3_4.csv` (gzip) + `manifest.csv` | Not found | Manifest flags `suspect` days; no revision process documented | Free |
| OpenSky | 2013 (collection); Trino historical DB | state vectors (1 s), flights | Trino SQL (approved accounts only) | Non-profit research/government; commercial licence on request | n/a | Free for research; commercial pricing not published |
| ADS-B Exchange | Jul 2016 (60 s), May 2020 (5 s) | 5 s snapshots, traces | Free sample = 1st of every month; full history by contract (S3 push) | Commercial use needs written authorisation | n/a | Full history: quote-only |
| FAA NOTAM archive | Rolling 3–5 years | per NOTAM | FNS NOTAM Search archive (per location+date); no bulk | US government | NOTAMs are cancelled/replaced, not revised | Free |
| EASA CZIB / FAA SFAR | Bulletin-level | document | Web pages, PDFs | Public | Revisions numbered (R1, R2...) | Free |
| IODA | API has data back to ~2019 (Google) and ~2022 (BGP, active probing, telescope) for the probes I ran | 5–30 min | REST API v2 (`/v2/signals/raw/...`) | Not found for API; CAIDA AUA governs raw data | Not found | Free |
| Cloudflare Radar | Radar launched 2020-09; outage annotations from 2022-09 | 15 min to 1 week | REST API (token); `dateStart`/`dateEnd` | **CC BY-NC 4.0** | Not found | Free API; commercial use not covered by the licence |
| URLhaus (abuse.ch) | 2018 | per URL | Dumps cover only active URLs + last 90 days; history needs per-URL API or own collection | Not-for-profit free; commercial = paid Spamhaus subscription | URL status changes (online/offline) | Free (non-commercial) |
| AbuseIPDB | n/a | per IP report | Per-IP `maxAgeInDays` 1–365; no bulk history | Proprietary | n/a | Free tier 1,000 checks/day; paid tiers |
| Shodan Trends | 2017 | monthly | Trends API/CSV export | Shodan membership terms | n/a | Uses query credits in any paid membership |
| Censys | ~5 years of daily snapshots | daily snapshot | Research access (free, vetted) or commercial | Commercial or research agreement | n/a | Free for vetted research |
| Yahoo Finance | ^GSPC 1927-12-30, CL=F 2000-08-23, BZ=F 2007-07-30 (probed `firstTradeDate`) | daily | Unofficial chart endpoint | No commercial use without permission | Corporate-action adjustments rewrite past adjusted prices | Free, terms-restricted |
| FRED / ALFRED | Per series (some 1700s+) | per series | API (key; 120 req/min) | Commercial OK; third-party series copyrights apply | Yes; ALFRED vintages give as-of values | Free |
| EIA Open Data | Per series (weekly petroleum from 1980s) | weekly/monthly | API v2 (key) + bulk zip (no key, refreshed twice daily) | Public domain (US gov) with reuse policy | Weekly figures revised later (monthly PSM) | Free |
| Polymarket | Launch ~2020 | market-level; price points | Gamma API (closed markets); CLOB `/prices-history` | Not found for API data | Resolved markets: only ≥12 h price granularity | Free |
| Kalshi | 2021 | market, candlesticks 1 m/1 h/1 d | `/historical/*` endpoints past the cutoff | Not found | Settled markets move to historical tier | Free |
| TradingView | n/a | n/a | No public data API; CSV export of charted bars only (10k–40k bars by plan) | Proprietary | n/a | Paid plans |
| USGS ComCat | Catalog goes back centuries; dense from 1970s | event | FDSN API, max 20,000 events per query | US public domain | Events are revised (magnitude/location updates) | Free |
| NASA FIRMS | MODIS 2000-11-01; VIIRS S-NPP 2012-01-20; NOAA-20 2018-04-01; NOAA-21 2024-01-17 | per detection | Archive Download Tool (email delivery; CSV/SHP/JSON) | NASA open data | NRT replaced by standard product after ~2–5 months | Free |
| GDACS | 2000 (per API description) | event + episodes | `gdacsapi/api/events/geteventlist/SEARCH` (paginated, date filter) | Attribution "GDACS" + disclaimer | Alert levels updated per episode | Free |
| EM-DAT | 1900 | event | xlsx download after login | Non-commercial free; **commercial = paid annual licence** | Records corrected over time | Free / paid |
| NWS alerts | api.weather.gov keeps 7 days; IEM archive: county 1986, polygons 2002, all VTEC 2005-11-12 | per alert | IEM shapefile/KML/Excel (1 year per request without state filter); NCEI official archive | US public domain | Initial polygon only in IEM | Free |
| ERA5 | 1940-01-01 | hourly, 0.25° | CDS API; also GEE, Planetary Computer, AWS | CC BY 4.0 (since 2025-07-02) | ERA5T preliminary values replaced by final ERA5 after ~2–3 months | Free |
| HDX HAPI | Varies by theme (conflict events from 1997) | admin-level, monthly/annual | API (app_identifier; 10,000 rows/call; ~1 req/s) | Per underlying source (e.g. ACLED terms) | Follows source revisions | Free |
| UNHCR | 1951 | country-year (plus mid-year) | API `api.unhcr.org/population/v1/` (no key) | CC BY 4.0 (some third-party indicators excepted) | Past years revised in each release | Free |
| IOM DTM | Not found | admin0/1/2 per reporting round | API v3 (subscription key) | Not found | Rounds, not revisions | Free |
| ReliefWeb | 1996 (reports), some 1980s | per report/disaster | API v2: 1,000 entries/call, 1,000 calls/day; pre-approved appname since 2025-11-01 | Content copyrights stay with original sources | Edits possible | Free |
| IDMC GIDD/IDU | 2008 (disaster), 2009 (conflict) | country-year; IDU events (last 180 days) | API; downloads | Terms page exists; licence not confirmed | Annual GIDD figures revised; IDU is provisional | Free |
| OFAC SDN | 1994 (text changes 1994–2023), PDF 2001– | per change | Archive files; SLS delta file; XML | US public domain | Append-only change log | Free |
| EU consolidated list | FSF real-time since 2019-07 | per entity | XML: DELTA, GLOBAL, ANNUAL (with modification history) | Not found (EU public) | ANNUAL.xml carries history | Free |
| IFES ElectionGuide | 1998 | per election | Portal CSV (registered); API (token by email) | Not found | Not found | Free (registration) |
| ACAPS | INFORM Severity from 2019 (beta) | crisis-month | API with auth token | Not found | Not found | Free (registration) |
| Common Crawl CC-NEWS | 2016-08 | daily WARC files | S3 `commoncrawl/crawl-data/CC-NEWS/` | CC terms of use; content copyright stays with publishers | Append-only | Free (egress if outside us-east-1) |
| Internet Archive (RSS) | Varies per URL | per capture | CDX API per URL; bulk only by partnership | IA terms; content copyright stays with publishers | Append-only | Free |

## Per-source notes

### Conflict and unrest

**UCDP GED and Candidate Events**
- GED v26.1 covers 1989–2025, event-level with day resolution, CSV/Excel, CC BY 4.0. Candidate Events releases monthly (latest 26.0.8, Aug 2026). https://ucdp.uu.se/downloads/
- API: token required since Feb 2026 (header `x-ucdp-access-token`, granted by email in 3–5 working days). Quota 5,000 requests/day, and errors count. Paging is mandatory. Every GED version from 5.0 to 26.1 and every candidate version (monthly `XX.0.Y`, quarterly `XX.01.XX.QQ`) is addressable, which gives true as-of snapshots. https://ucdp.uu.se/apidocs/
- Revisions: each annual GED re-releases the whole series, and candidate events are replaced by the next GED. The per-version API is the way to keep as-of history.
- Size: country-day over 1989–2025 is about 13,500 days × ~195 countries ≈ 2.6M rows if dense. Real data is sparse. Small in either case (tens of MB).

**GDELT**
- GDELT 2.0 started late morning 2015-02-19 (announcement), and the probed master file list starts at `20150218230000`. Events, Mentions and GKG update every 15 minutes. The announcement promised a GDELT 2.0-format backfile to 1979. I found no evidence it was delivered. https://blog.gdeltproject.org/gdelt-2-0-our-global-world-in-realtime/
- Probed: `https://data.gdeltproject.org/gdeltv2/masterfilelist.txt` and `lastupdate.txt`. Latest 15-min files are ~67 KB (events), ~115 KB (mentions) and ~5 MB (GKG) zipped. Early-2015 GKG files were ~10 MB. Rough totals: events ~10 MB/day zipped (~40 GB over the archive), GKG ~0.5–1 GB/day zipped (low single-digit TB over the archive).
- GDELT 1.0 events: 1979–present. Yearly zips to 2005, monthly 2006–Mar 2013, daily from 2013-04-01. Probed `data.gdeltproject.org/events/index.html`: daily files still publish (20261008 = 7.6 MB). Sizes: https://en.wikipedia.org/wiki/GDELT_Project
- BigQuery: every GDELT dataset is in BigQuery, updated every 15 minutes (https://www.gdeltproject.org/data.html). Partitioned tables cut scan cost (https://blog.gdeltproject.org/announcing-partitioned-gdelt-bigquery-tables/). The GKG table was 3.6 TB when GDELT reported it (https://blog.gdeltproject.org/?p=3185). On-demand pricing is $6.25/TiB with 1 TiB/month free (https://cloud.google.com/bigquery/pricing).
- Licence: "unlimited and unrestricted use for any academic, commercial, or governmental use of any kind without fee", with citation. https://www.gdeltproject.org/about.html
- Revisions: no revision process is documented. Files are append-only, so a stored file is its own as-of snapshot.
- DOC 2.0 API: the default window is 3 months. Timeline modes reach back to 2017-01-01. Article-list modes return only the most recent 3 months of any window. https://blog.gdeltproject.org/doc-2-0-updates-1-5-year-searching-and-updated-mobile-interface/ and https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
- Country-day aggregate: 2015-02 onward is ~4,250 days × ~250 FIPS countries ≈ 1.1M rows. From GDELT 1.0 (1979): ~17,400 days ≈ 4.4M rows.

**VIEWS (Uppsala/PRIO)**
- Monthly forecasts at country-month (`cm`) and PRIO-GRID-month (`pgm`), up to 36 months ahead. https://viewsforecasting.org/data/
- The API at `https://api.viewsforecasting.org/` lists every run: ESCWA 2021, fatalities001 (Dec 2021–Mar 2023), fatalities002 (Apr 2023–Oct 2025), fatalities003 (Oct 2025–Aug 2026). Each run is named `{model}{version}_{year}_{month}_{try}`, so past forecasts can be fetched as published. Filters cover ISO, country ID, bbox and date/month_id. Codebook is at `/{run}/codebook`. https://github.com/prio-data/views_api/wiki
- The API is labelled alpha (v0.3). https://github.com/prio-data/views_api
- Licence: not found on the data page or API wiki.
- Size: cm ≈ 191 countries × 36 steps per run. One country-month row per run step is small.

**Wikipedia Current Events Portal / Wikidata**
- WCEP has one page per day with monthly archive pages. Archives reach back to about 2002–2003. https://he.wikipedia.org@en.wikipedia.com/wiki/Wikipedia:How_the_Current_events_page_works (mirror of the help page)
- Wikidata structured data is CC0. https://www.wikidata.org/wiki/Wikidata:Licensing
- Wikipedia text is CC BY-SA (share-alike applies to derived text, not to facts). Dumps are at https://dumps.wikimedia.org (not separately verified in this pass).
- Revisions: pages are edited after the fact. Full revision history is kept, so any as-of state can be rebuilt.

**Powell & Thyne coups**
- Coups from 1950 to present. Current version is dated 2026-08-29. CSV/Excel, with an archive of previous versions by publication date. https://jonathanmpowell.com/coups
- TXT file: https://www.uky.edu/~clthyn2/coup_data/powell_thyne_coups_final.txt
- Licence: not found. Citation is requested (JPR 2011).

**Archigos / REIGN**
- Archigos v4.1 covers leaders 1875–2015 (updated to 2015-12-31). https://rochester.edu/college/faculty/hgoemans/data.htm
- REIGN is discontinued. The GitHub data folder ends at `REIGN_2021_8.csv` and `leader_list_8_21.csv`. The status page reads "August 2021 REIGN Dataset: as of August 3rd, 2021". The last commit was 2023-09-08 (page text only). https://github.com/OEFDataScience/REIGN.github.io (probed via the GitHub API)
- Licence: repository MIT. Data licence not found.

### Shipping and trade

**IMF PortWatch**
- Daily Chokepoints: daily transit calls and estimated trade volume for 28 chokepoints. Built from the UN Global Platform AIS archive starting 2018-12-01 (Spire satellite plus FleetMon terrestrial). Licence pointer is https://www.imf.org/external/terms.htm. Citation: "Sources: UN Global Platform; IMF PortWatch". Metadata: https://services9.arcgis.com/weJ1QsnbMYJlCHdG/ArcGIS/rest/services/Daily_Chokepoints_Data/FeatureServer/info/itemInfo?f=pjson
- IMF data terms let users download, copy, publish and sell IMF data with "Source: International Monetary Fund" attribution. Material transformations must be stated. https://lists-archive.okfn.org/pipermail/od-discuss/2015-March/004247.html (discussion quoting the IMF licence)
- Port data: ~1,854 ports. Moved from weekly to daily updates. https://geo.btaa.org/catalog/6cd84ca4-63e9-43b8-8dd9-32d4a0f3d128 and https://unstats.un.org/bigdata/events/2025/ai-data-science/webinar1/presentations/Mario%20and%20Alessandra%20-%20PortWatch%20-%20UNGP.pdf
- Access: ArcGIS REST FeatureServer queries (paginated by `resultOffset`). FAQ: https://portwatch.imf.org/pages/faqs (content did not render for me).
- Revisions: not found. Trade volumes are model estimates, so treat them as revisable and snapshot them.
- Size: chokepoints ≈ 28 × ~2,870 days ≈ 80k rows. Ports ≈ 1,850 × ~2,800 days ≈ 5M rows.

**UNCTAD port calls**
- Port-call statistics by semester or year, based on MarineTraffic AIS, vessels ≥1,000 GT. https://www.un-ilibrary.org/content/books/9789210019156c006
- Semi-annual series: https://stats.unctad.org/portcalls_number_sa. A DBnomics mirror was stale (last updated 2021-03-12). https://db.nomics.world/UNCTAD/PCAPSNOPCA
- Licence and revisions: not found.

**Commercial AIS history**
- MarineTraffic: Essential £100/month (7-day track history). Enterprise covers 5,000 vessels and up to 5 years of track history, by quote. https://maritimepage.com/marinetraffic-vs-vesselfinder/
- Datalastic: €199/month (20k requests) to €679/month (unlimited). https://datalastic.com/pricing/
- Free alternative: Global Fishing Watch derives port visits from AIS since 2012, free for non-commercial use with a stated purpose. https://globalfishingwatch.org/our-apis
- Verdict: per-vessel history is unaffordable at scale. PortWatch aggregates are the realistic backfill.

### GPS and aviation

**gpsjam.org**
- Daily since 2022-02-14. H3 hexes. Data from ADS-B Exchange and airplanes.live. Several dates have 6–37 h gaps. https://gpsjam.org/faq
- Probed bulk format: `https://gpsjam.org/data/manifest.csv` (gzip; `date,suspect,num_bad_aircraft_hexes,source`; 2022-02-14 to 2026-10-08, source changes from `adsbexchange` to `merged`). Daily file: `https://gpsjam.org/data/YYYY-MM-DD-h3_4.csv` (gzip; `hex,count_good_aircraft,count_bad_aircraft`). 2024-06-01 had 41,630 rows, 165 KB gz, 867 KB raw.
- Size: ~1,700 days × ~165 KB ≈ 280 MB gz for the full archive.
- Licence: not found. Ask the author before publishing derived data.

**OpenSky Network**
- Collection since 2013. Trino SQL gives access to the full historical DB (`state_vectors_data4`, flights, raw Mode S). Access is limited to university researchers, government organisations and aviation authorities. https://opensky-network.org/data/scientific and https://openskynetwork.github.io/opensky-api/trino.html
- The REST API is for research and non-commercial purposes. Commercial use is by contact. https://openskynetwork.github.io/opensky-api/
- A commercial company is unlikely to qualify for research access.

**ADS-B Exchange**
- Free samples: complete data for the 1st of every month (readsb-hist, traces, hires traces, flights, ACAS, operations). readsb-hist is every 5 s from May 2020 and every 60 s from July 2016. https://www.adsbexchange.com/data-products/sample-data/
- Commercial use needs written authorisation and a data licence. Full history is pushed to S3/Azure by contract, priced by quote. https://adsbexchange.com/?p=19798

**NOTAMs and airspace closures**
- The FAA FNS NOTAM Search links to an archive with about three years of history, queried per location and date. https://nbaa.org/aircraft-operations/airspace/navigator-improved-notam-search-coming-this-fall/
- The federal records schedule keeps NOTAMs at least 5 years after expiry. https://www.archives.gov/records-mgmt/rcs/schedules/departments/department-of-transportation/rg-0237/daa-0237-2022-0014_sf115.pdf
- No bulk historical NOTAM archive found. ICAO API historical NOTAM: not found.
- Airspace closure records: EASA CZIBs (revision-numbered) at https://www.easa.europa.eu/en/domains/air-operations/czibs. FAA SFAR prohibitions at https://www.faa.gov/air_traffic/publications/us_restrictions. No consolidated historical closure dataset found.

### Internet and cyber

**IODA**
- Probed API v2 (`/v2/signals/raw/country/{cc}?from&until`) for Iran and Egypt. Google Transparency (`gtr`) data appeared from 2019 (patchy). BGP, merit-nt telescope and ping-slash24 active probing appeared from early 2022 (present 2022-03-10, absent 2021-12-10). Steps are 300 s (BGP/telescope), 600 s (active) and 1,800 s (gtr). Older CAIDA-era history (IODA dates to ~2016) did not come back from this API.
- Licence: API terms not found. CAIDA raw data falls under the CAIDA AUA, which is research-only and bans redistribution. https://www-old.caida.org/funding/paridine-iodanp/paridine-iodanp-privacyplan.pdf
- Size: 3 signals × 195 countries × ~1,700 days (daily aggregates) ≈ 1M rows.

**Cloudflare Radar**
- Licence is **CC BY-NC 4.0** for API and downloads. https://radar.cloudflare.com/about (via search snippet; direct fetch returned 403)
- Radar launched 2020-09. The Outage Center and API launched 2022-09. https://blog.cloudflare.com/announcing-cloudflare-radar-outage-center
- Relative `dateRange` goes up to 364 d or 52 w. Absolute `dateStart`/`dateEnd` are supported. https://developers.cloudflare.com/radar/get-started/making-comparisons/
- Earliest queryable date for absolute ranges and retention: not found.
- NC licence: commercial reuse of the raw series needs Cloudflare's permission.

**URLhaus / abuse.ch**
- Dumps (CSV/JSON, regenerated every 5 min, Auth-Key required) cover only URLs that are active or added in the last 90 days. No full-history dump. https://urlhaus.abuse.ch/api/
- Terms: free for authenticated not-for-profit use. Commercial use needs a paid Spamhaus subscription (or six months of contributions). https://abuse.ch/terms-of-use/
- ~3.8M URLs since 2018 (third-party figure). https://urlhaus.abuse.ch/about

**AbuseIPDB**
- `maxAgeInDays` is 1–365 on per-IP checks and reports. Reports are capped at 10,000 elements. No bulk historical export found. https://docs.abuseipdb.com/
- Free tier: 1,000 checks/day. Paid tiers raise limits (third-party summary): https://wiki.iphoster.net/wiki/AbuseIPDB_-_IP_reputation_check_-_2026

**Shodan / Censys**
- Shodan Trends: monthly history back to 2017, CSV export. Each search uses 1 query credit from any membership. https://trends.shodan.io/ and https://blog.shodan.io/introducing-shodan-trends/
- Censys: daily snapshots, about 5 years retained. Free research access for vetted researchers, otherwise commercial. https://docs.censys.com/docs/research-access-to-censys-data

### Markets and energy

**Yahoo Finance**
- Probed the chart endpoint `query1.finance.yahoo.com/v8/finance/chart/{sym}?range=max`. `firstTradeDate`: ^GSPC 1927-12-30, CL=F 2000-08-23, BZ=F 2007-07-30. `range=max&interval=1d` is downsampled to monthly bars, so daily history needs chunked `period1`/`period2` requests.
- Terms: Yahoo APIs may not be used "for direct commercial or monetary gain" without written permission. https://legal.yahoo.com/us/en/yahoo/terms/product-atos/apiforydn/index.html
- yfinance states the data is for personal use. https://github.com/ranaroussi/yfinance
- Revisions: adjusted close is rewritten after splits and dividends. Store raw OHLC plus corporate actions.
- Size: ~25k rows for a century of daily bars per asset.

**FRED / ALFRED**
- Commercial apps are allowed. Must display the "not endorsed" notice. Third-party copyrighted series need owner permission. The St. Louis Fed may set limits at its discretion. https://fred.stlouisfed.org/docs/api/terms_of_use.html
- 120 requests/min per key (third-party docs): https://glama.ai/mcp/servers/@stefanoamorelli/fred-mcp-server/blob/41a5270f604aef6d81d0c33a9f2054be0d43a4dd/docs/api-reference/overview.mdx
- `realtime_start`/`vintage_dates` return ALFRED vintages, which gives true as-of values. https://erised.las.iastate.edu/CRAN/web/packages/fredr/news/news.html

**EIA**
- API v1/v2 with a free key. Bulk zip files refresh twice daily (5 a.m. and 3 p.m. ET). Free of charge under the EIA copyright and reuse policy. https://www.eia.gov/opendata/
- The WPSR publishes Wednesdays at 10:30 ET. https://www.eia.gov/TODAYinENERGY/detail.php?id=43276
- Start dates are per series; weekly crude stocks begin in the 1980s (from EIA series pages, not verified here). Weekly estimates are later revised against monthly survey data, and the API serves only current values, so snapshot weekly releases to keep as-of copies.

**Polymarket**
- Three public APIs: Gamma (discovery, including closed markets), CLOB (`/prices-history`) and Data API (trades, OI). https://www.predictionhunt.com/blog/polymarket-api-complete-guide
- Gamma rate limits: 4,000 req/10 s overall, `/markets` 300 req/10 s. https://docs.polymarket.com/api-reference/rate-limits
- Resolved markets return price history only at ≥12 h fidelity. Finer fidelity comes back empty. https://github.com/Polymarket/py-clob-client/issues/216
- Docs: https://docs.polymarket.com/api-reference/markets/get-prices-history. The fetch failed with ECONNRESET, and live probes of the Gamma API also reset from this network. Redistribution terms for API data: not found.
- Implication: tick-level history for resolved markets is unavailable. Collect it live.

**Kalshi**
- Data is split into live and historical tiers. `GET /historical/cutoff` returns `market_settled_ts`, `trades_created_ts` and other cutoffs. Endpoints include `/historical/markets`, `/historical/markets/{ticker}/candlesticks`, `/historical/trades`. https://docs.kalshi.com/getting_started/historical_data
- Archive reaches back to the 2021 launch (third-party). https://www.predictionhunt.com/blog/polymarket-kalshi-historical-data
- Redistribution terms: not found.

**TradingView**
- No public data API. Chart CSV export only, capped at 10k/20k/40k bars by plan. https://blog.traderspost.io/article/tradingview-data-export

### Hazards and climate

**USGS ComCat**: FDSN event API. Max 20,000 events per query (larger requests return HTTP 400). QuakeML, GeoJSON, CSV, KML. The docs recommend real-time feeds for automated displays. Events are revised (magnitude and location updates), so store `updated` timestamps. https://earthquake.usgs.gov/fdsnws/event/1/

**NASA FIRMS**: Archive start dates are MODIS C6.1 2000-11-01, VIIRS S-NPP 2012-01-20, NOAA-20 2018-04-01, NOAA-21 2024-01-17 and Landsat 2022-06-20. CSV/SHP/JSON by emailed request with Earthdata login. NRT is replaced by standard science-quality data after ~5 months (download page) or 2–3 months (older doc). https://firms.modaps.eosdis.nasa.gov/download/. Country-day: ~195 × 9,450 days ≈ 1.8M rows.

**GDACS**: `https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH` (GeoJSON, paginated, `fromdate`/`todate`, alert level, event type). History from 2000 (per third-party description). Swagger at https://www.gdacs.org/gdacsapi/swagger/index.html. Attribution "Global Disaster Alert and Coordination System, GDACS". Terms: https://www.gdacs.org/documents/2025/GDACS_Terms_of_use_Mar_25.pdf. Source summary: https://ifrcgo.org/monty-stac-extension/model/sources/GDACS/

**EM-DAT**: 26,700+ disasters since 1900. Free xlsx after registration for non-commercial use. Commercial use, defined as any entity that is not academic, non-profit or an international public body, needs an annual paid licence. https://doc.emdat.be/docs/legal/terms-of-use/ and https://doc.emdat.be/legal/database-license-agreement-2025

**NWS alerts**: api.weather.gov `/alerts` holds 7 days. NCEI holds the official CAP archive. https://weather.gov/documentation/services-web-api. The Iowa Environmental Mesonet has county warnings since 1986-01-01, polygons since 2002-01-01 and all VTEC products since 2005-11-12. Shapefile/KML/Excel, 1 year per request unless filtered by state or WFO. Pre-generated annual files exist. Only the initial polygon is kept. https://mesonet.agron.iastate.edu/request/gis/watchwarn.phtml

**ERA5**: hourly from 1940, 0.25°. CC BY 4.0 replaced the Copernicus licence on 2025-07-02. https://forum.ecmwf.int/t/cc-by-licence-to-replace-licence-to-use-copernicus-products-on-02-july-2025/13464. Also on Google Earth Engine (https://developers.google.com/earth-engine/datasets/catalog/ECMWF_ERA5_MONTHLY). Near-real-time ERA5T values are replaced by final ERA5 (general knowledge, not verified in this pass).

### Humanitarian and displacement

**HDX HAPI**: `app_identifier` required. 10,000 entries per call, ~1 req/s. https://docs.humdata.org/about/hdx-terms-of-service/hapi-terms-of-service. Coverage differs by theme: conflict events back to 1997, operational presence current year only. https://hdx-hapi.readthedocs.io/en/latest/. Licences follow each source. The conflict data is ACLED, which carries its own restrictive terms.

**UNHCR**: `https://api.unhcr.org/population/v1/` (no key). Data from 1951. https://glama.ai/mcp/servers/@rvibek/mcp_unhcr/blob/5a9dd49e056a1675b871534131eb8be59b89cb26/README.md. CC BY 4.0, with third-party indicators excepted. https://www.unhcr.org/terms-use-datasets. Past figures are revised in each release (common practice; not documented on the page I read).

**IOM DTM**: API v3 needs a personal subscription key (https://dtm-apim-portal.iom.int/). IDP figures at admin 0/1/2 by reporting round, with sex, origin and reason breakdowns. https://dtmapi.readthedocs.io/en/latest/. Coverage start, terms and rate limits: not found.

**ReliefWeb**: Reports since 1996 (some 1980s UN reports). 1,000 entries per call, 1,000 calls per day. Pre-approved appname required from 2025-11-01. Content copyright stays with original sources. https://apidoc.reliefweb.int/

**IDMC**: GIDD covers disasters since 2008 and conflict since 2009. IDU holds provisional events from the last 180 days, updated daily. https://internal-displacement.org/database and https://internal-displacement.org/database/api-documentation. Licence: a terms page exists, type not confirmed.

### Sanctions and politics

**OFAC SDN**: Change archive as PDF 2001–present and TXT 1994–2023. https://ofac.treasury.gov/specially-designated-nationals-list-sdn-list/archive-of-changes-to-the-sdn-list. The Sanctions List Service offers a public delta file and XML. https://ofac.treasury.gov/faqs/topic/1641. Append-only, which gives a real as-of history.

**EU consolidated list**: Three XML files: DELTA (latest changes), GLOBAL (snapshot) and ANNUAL (all records with modification and deletion history). https://ec.europa.eu/external_relations/cfsp/sanctions/list/version4/global/help_online/process_xmlfiles.html. FSF real-time since July 2019. OpenSanctions keeps a full historical archive, but pre-2024 exports now need authenticated access. https://www.opensanctions.org/datasets/eu_fsf/ and https://www.opensanctions.org/changelog. EU sanctions map history: not found.

**IFES ElectionGuide**: National elections from 1998 in 240 countries. XLSX/CSV for registered users; API JSON (a subset) with a token by request. No licence stated. Disclaims accuracy. https://electionguide.org/p/access/ and https://www.ifes.org/news/every-election-everywhere-ifes-announces-expansion-electionguide-database

**ACAPS**: Free API with credentials-to-token auth (`/api/v1/get-auth-token/`). https://api.acaps.org/ and https://reliefweb.int/report/world/acaps-datasets-now-centralised-and-easily-accessible-through-its-new-api. The INFORM Severity Index beta began in 2019. https://www.ncbi.nlm.nih.gov/pmc/articles/PMC9887746/. Licence and revision policy: not found.

### News

**GDELT GKG as a news history proxy**: see GDELT above. 2015-02 onward at 15-minute granularity. It carries themes, locations, tone and source URLs, but no article text.

**Common Crawl CC-NEWS**: Since 2016 (announced October 2016). Daily WARC files at `s3://commoncrawl/crawl-data/CC-NEWS/YYYY/MM/`. Over 100 TB uncompressed HTML across 2016–2026. Released "without additional intellectual property restrictions", but article copyright stays with publishers. https://blog.commoncrawl.org/blog/news-dataset-available and https://commoncrawl.org/terms-of-use

**Internet Archive RSS**: CDX API per URL (`web.archive.org/cdx/search/cdx?url=`). No hard published limit, so throttle requests. Bulk access needs a partnership. https://npmjs.com/package/mcp-wayback-machine. RSS capture coverage varies per feed and must be checked per feed URL with CDX. Note: Wayback is slow or unreachable from Railway (see repo gotcha `railway-deploy-gotchas`).

## Backfill priorities this suggests

1. Cheap, deep, licence-clean: GDELT 1.0/2.0 events (bulk files), UCDP GED + candidate versions, USGS, FIRMS, GDACS, ERA5, UNHCR, OFAC/EU XML history, FRED/ALFRED, EIA bulk, PortWatch, gpsjam (licence to confirm).
2. Collect-forward only (no usable public history): Polymarket intraday, URLhaus, AbuseIPDB, NOTAMs, NWS CAP beyond IEM, IODA before 2022.
3. Licence blockers for commercial publication: Cloudflare Radar (NC), EM-DAT, OpenSky, ADS-B Exchange, Yahoo, abuse.ch, ACLED (via HAPI).
