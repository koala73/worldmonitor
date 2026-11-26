# Regional energy fixtures

Captured from public provider responses on 2026-10-29. Source catalog URLs and
licence caveats are in `scripts/shared/regional-energy-feeds.json` and
`docs/regional-energy-feeds.md`.

HTML and CSV fixtures retain only representative headers and rows. CAMMESA JSON
retains representative national samples. Petrobangla and GSE JSON contain text,
coordinates and widths extracted from the first page of their current English
PDFs; blank cells retain their original positions.

The Eskom fixtures include synthetic future zero placeholders and an observed
night-time solar zero to test the exclusion rule. Scientific notation is tested
inline using the format observed in the full renewable CSV. ANP price rows are
constructed inline with the actual national workbook headers and units.

Batch 2 fixtures (`evn-*`, `korem.json`, `coes.json`, `iccc-*`,
`fccc-*`) were captured on 2026-10-31 with the WorldMonitor User-Agent, except
`iccc-post-2026-11.json`, captured on 2026-11-07. The ICCC
responses are unmodified. The EVN pages are trimmed to the bulletin list and
bulletin body; each starts with a comment naming its source URL and capture
time. `coes.json` wraps the unmodified response with its capture time and POST
request. `korem.json` maps each requested
portal URL to its response. `fccc-items-*.json` hold the text items extracted
from every page of the FCCC release PDFs.

`mem-daily.json` was captured on 2026-11-01 from MEM's
`Precios-Promedio-Nacionales-Diarios-2026-3.xlsx` upload with the WorldMonitor
User-Agent. It holds the worksheet's cell values: the title and header rows,
the newest 40 dated rows and the source and note rows. Dates are stored as
`{ "date": ISO }`; the tests rebuild a workbook from these rows.

The Western Balkan grid fixtures (#10051) were captured on 2026-11-26 with the
WorldMonitor User-Agent and are unmodified responses: `ems-live-2026-11-26.json`
and `ems-live-2026-11-25.txt` (a PHP notice and `null`) from EMS's
`aload/get_results.php`, `ems-realised-2026-11-2{4,5}.json` and
`ems-realised-2026-10-25.json` (a DST change day) from `dload/get_results.php`,
and `nosbih-2026-*.json` from the NOS BiH AJAX POST for 24 November (complete),
26 November (partly metered) and 25 October (23 rows). `mepso-items-2026-11-23.json`
holds the text items of MEPSO's report for 23 November 2026, and
`mepso-home.html` is the home page trimmed to its daily report links. Expected
values are read directly from these responses; MEPSO's totals were checked
against the sum of their hourly figures and the report's energy balance.

Batch 3 fixtures (#10051) were captured on 2026-11-02 with the WorldMonitor
User-Agent. `qatarenergy-items.json`, `erb-items-2026-11.json`,
`anptl-items-2026-10-20.json` and `doe-ncr-items-2026-10-27.json` hold the text
items extracted from every page of the provider PDFs. `erb-posts.json`,
`anptl-posts.json`, `anptl-post-12450.json`, `npa-media-*.json` and
`sonabhy-tarifs.json` are unmodified REST responses. `npa-expump-2026-10-16.json`
holds the newest sheet of the ex-pump workbook and
`npa-indicators-2026-10-20.json` the indicator sheet, as cell values with dates
stored as `{ "date": ISO }`; the tests rebuild workbooks from these rows.
`sonabhy-page.html` keeps only the page's Nuxt state script tag and
`sonabhy-state.js` is that state. `zera-home.html` is trimmed to the price
widget, `creg-page.html` to the three newest price tables, `doe-ncr-page.html`
to the payload fragments that link each weekly PDF, and the three `ursea-*.html`
pages to their `<main>` element. Each HTML fixture starts with a comment naming
its source URL.

`fuelwatch-retail-2026-11-excerpt.csv` is a verbatim excerpt of
`https://warsydprdstafuelwatch.blob.core.windows.net/historical-reports/FuelWatchRetail-11-2026.csv`
as read on 2026-11-26 (FuelWatch Historic Fuel Prices, CC BY 4.0): every 30th
station by trading name, 24 and 25 November, all products. Its expected medians
for 25 November (ULP 2.099, PULP 2.229, 98 RON 2.319, diesel 2.569 AUD/l) and
the 24 November ULP median (1.947) were computed from the CSV independently
with Python's `statistics.median`.

`searg-surtidor-2024-02-06.csv` (#11154) is an unmodified excerpt of the
Secretaría de Energía "Precios vigentes en surtidor - Resolución 314/2016" CSV
(CC-BY-4.0): the header and every row of the first 40 stations, in file order,
from the Internet Archive capture of 2024-02-06 08:41:39 UTC
(`web.archive.org/web/20240206084139id_/http://datos.energia.gob.ar/...`). The
live host refused connections when the feed was written. The tests freeze time
at 2024-02-06 12:00 UTC.

`oil111-92.json`, `oil111-95.json`, `oil111-98.json`, `oil111-diesel.json` and
`oil111-lpg.json` are the unmodified (re-indented) responses of
`https://www2.moeaea.gov.tw/oil111/{Gasoline,LPG}/CountyCityAvg/load` posted with
`unit=week|month`, `oil=01..05` and `start=lastone` on 2026-11-26. Their expected
national and county means (92: 31.11 national, 31.2 Taipei; 95: 32.54; diesel:
29.74; LPG: 768.01 national, 844 Taipei, 1000 Lienchiang) were computed from the
JSON independently with Python, weighting groups by surveyed stations.
