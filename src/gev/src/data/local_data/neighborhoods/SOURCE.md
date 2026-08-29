# Bundled neighborhood polygons — provenance & license

These per-city GeoJSON files give the annotation resolver **real neighborhood boundaries**
for places OSM tags as label-nodes-only (Chinatown, the Marina, the Mission, …), instead of
a flaky live-Overpass lookup or a synthesized buffer disc. Looked up by point-in-polygon +
name (see `src/data/neighborhoodPolygons.js`).

## Provenance

| File | Source | License | Retrieved |
|---|---|---|---|
| `san-francisco.json` | City & County of San Francisco — **DataSF "Analysis Neighborhoods"** (dataset `j2bu-swwd`, published via map view [`p5b7-5n3h`](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h)) | **PDDL 1.0** (Open Data Commons Public Domain Dedication and License — public domain) | 2026-07-30 |

### san-francisco.json

- **Downloaded from:** `https://data.sfgov.org/resource/j2bu-swwd.geojson?$limit=100`
  (HTTP 200, 1,713,909 bytes, retrieved 2026-07-30). The catalog page is the
  "Analysis Neighborhoods" map view `p5b7-5n3h`, which is backed by dataset
  `j2bu-swwd` (columns `the_geom`, `nhood`); the legacy
  `api/geospatial/p5b7-5n3h?method=export` endpoint no longer serves the geometry
  after DataSF's November 2023 map-format migration.
- **License evidence:** the dataset metadata (`https://data.sfgov.org/api/views/j2bu-swwd.json`,
  and identically on `p5b7-5n3h`) declares
  `"licenseId": "PDDL"` / `"license": {"name": "Open Data Commons Public Domain
  Dedication and License", "termsLink": "http://opendatacommons.org/licenses/pddl/1.0/"}`.
  Public domain — fully compatible with this repo's public release.
- **Content:** all **41** Analysis Neighborhoods, created by SF DPH and the Mayor's
  Office of Housing and Community Development (with the Planning Department) from
  groupings of 2010 Census tracts. Dataset last updated upstream 2023-10-17.
- **Transform:** `scripts/build-sf-neighborhoods.mjs` (deterministic; re-run it against
  the raw download to reproduce the bundled file byte-for-byte):
  1. `properties.nhood` → `properties.name` — names kept **verbatim**, no renames or
     aliasing.
  2. Douglas-Peucker simplification per ring, tolerance 2e-5° (~2 m) — trims
     hyper-detailed shoreline vertices without visibly moving boundaries
     (42,667 → 9,150 vertices).
  3. Coordinates rounded to 6 decimals (~0.1 m), consecutive duplicates dropped,
     rings re-closed.
  4. Single-part MultiPolygons collapsed to `Polygon`; features sorted by name.

## File format

`FeatureCollection` with `city` + `features[]`, each `{ properties: { name }, geometry:
Polygon|MultiPolygon }`, coordinates `[lon, lat]` rounded to 6 decimals. The lookup module
is **source-agnostic** — to add or swap a city, drop in a file with this shape and register
it in `CITY_FILES` in `src/data/neighborhoodPolygons.js`.
