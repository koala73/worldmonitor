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
`fccc-*`) were captured on 2026-10-31 with the WorldMonitor User-Agent. The ICCC
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
