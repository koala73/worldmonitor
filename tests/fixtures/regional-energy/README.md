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
