---
title: "Maps Infrastructure & Geocoding"
description: "Static map assets, country geometry, geocoding services, and boundary overrides."
---

# Maps Infrastructure & Geocoding

Static map assets, country geometry, geocoding services, and boundary overrides.

## R2 CDN — `maps.worldmonitor.app`

All large static map files are served from Cloudflare R2, **not** from Vercel. The R2 bucket `worldmonitor-maps` is fronted by a CF-proxied custom domain:

| URL | Use |
|-----|-----|
| `https://maps.worldmonitor.app/<file>` | Production URL (CF-proxied, cached, CORS headers) |
| `https://pub-8ace9f6a86d74cb2bd5eb1de5590dd9e.r2.dev/<file>` | Raw R2 — **never use in code** (no CF caching, no CORS) |

### Why R2 instead of Vercel?

- Cloudflare bandwidth is free; Vercel charges per GB at scale
- CF Cache Rules cache `/data/`, `/assets/`, `/textures/` etc. for 30 days at edge
- Large files (GeoJSON, PMTiles) don't bloat the Vercel deployment

### Files on R2

| File | Size | Purpose |
|------|------|---------|
| `countries.geojson` | ~210 KB | Base country polygons (ISO 3166-1 Alpha-2 coded) |
| `country-boundary-overrides.geojson` | ~600 KB | Higher-resolution Natural Earth boundary overrides |
| `*.pmtiles` | ~80 GB | Self-hosted vector map tiles (when `VITE_PMTILES_URL` is set) |

### Uploading to R2

```bash
# Single file
rclone copyto <local-path> r2:worldmonitor-maps/<filename>

# rclone config note: set no_check_bucket = true (token lacks CreateBucket permission)
```

### CORS

R2 does **not** support wildcard subdomains (`https://*.example.com`). Each origin must be listed explicitly in the CORS rules. Use `r2 bucket cors set` or direct `curl -X PUT` to the R2 API (Wrangler 4.31 may fail with "not well formed").

## Country Geometry Service

**File**: `src/services/country-geometry.ts`

This service provides all country-level geocoding: point-in-polygon lookups, ISO code resolution, name matching, bounding boxes, and centroids. It loads country boundaries once on first use and indexes them for fast queries.

### Data Flow

```
countries.geojson (/data/)  ──►  Parse & Index (rebuildCountryIndex)  ──►  countryIndex Map
                                        │
country-boundary-overrides.geojson      │
  (R2 CDN, 3s timeout)     ──►  applyCountryGeometryOverrides  ──►  replace matching polygons
```

1. `countries.geojson` — base polygons with ISO codes and names, served from `/data/` (Vercel)
2. `country-boundary-overrides.geojson` — optional higher-resolution polygons from [Natural Earth](https://www.naturalearthdata.com/), served from R2 CDN (`maps.worldmonitor.app`). Features matched by `ISO3166-1-Alpha-2` (or `ISO_A2`) code; matching features replace the base geometry
3. Base file loads first and the country index is built immediately (service becomes usable). Override file is fetched afterward with a **3-second timeout** — failures are silently ignored. Override lookup uses a `Map<code, Feature>` for O(1) matching

### Indexed Data Structures

| Structure | Key | Purpose |
|-----------|-----|---------|
| `countryIndex` | ISO-2 code | Full geometry + bbox for point-in-polygon |
| `iso3ToIso2` | ISO-3 code | Alpha-3 → Alpha-2 conversion |
| `nameToIso2` | lowercase name | Country name → Alpha-2 lookup |
| `codeToName` | ISO-2 code | Code → display name |
| `sortedCountryNames` | — | Regex matchers sorted by name length (longest first) for text extraction |

### Key Exports

| Function | Purpose |
|----------|---------|
| `preloadCountryGeometry()` | Trigger early loading (call at app startup) |
| `getCountryAtCoordinates(lat, lon)` | Point-in-polygon → country code + name |
| `isCoordinateInCountry(lat, lon, code)` | Check if point is inside a specific country |
| `getCountryNameByCode(code)` | ISO-2 → display name |
| `iso3ToIso2Code(iso3)` | ISO-3 → ISO-2 |
| `nameToCountryCode(text)` | Exact name match → ISO-2 |
| `matchCountryNamesInText(text)` | Extract all country names from free text |
| `getCountryBbox(code)` | Bounding box `[minLon, minLat, maxLon, maxLat]` |
| `getCountryCentroid(code)` | Bbox center, with optional fallback bounds |
| `resolveCountryFromBounds(lat, lon, bounds)` | Resolve overlapping bounding-box regions using geometry |

### Name Aliases

Common alternate names are mapped in `NAME_ALIASES`:

```
'dr congo' → CD, 'czech republic' → CZ, 'uae' → AE, 'uk' → GB, 'usa' → US, ...
```

### Political Overrides

`POLITICAL_OVERRIDES` maps sub-national codes to sovereign codes where the app treats them as separate entities (e.g., `CN-TW → TW`).

## Country Boundary Overrides

The override mechanism lets us improve individual country boundaries without replacing the entire `countries.geojson`. This is the foundation for addressing disputed borders (see [#1044](https://github.com/koala73/worldmonitor/issues/1044)).

### How It Works

1. After loading base `countries.geojson`, the app fetches `country-boundary-overrides.geojson` from R2 CDN with a 3-second timeout
2. For each feature in the override file, it matches the country in `countries.geojson` by ISO Alpha-2 code (using a `Map` for O(1) lookup)
3. The override geometry **replaces** the base geometry (both in the raw GeoJSON used for map rendering and in the indexed point-in-polygon data)
4. The override file can contain any number of countries — only matching codes are applied

### Adding a New Country Override

1. Source the boundary from [Natural Earth 50m Admin 0](https://www.naturalearthdata.com/downloads/50m-cultural-vectors/) (depicts de facto boundaries — actual territorial control — not diplomatic claims)
2. Extract the country feature by ISO code and save as GeoJSON
3. Merge into or replace `country-boundary-overrides.geojson`
4. Upload to R2:
   ```bash
   rclone copyto public/data/country-boundary-overrides.geojson r2:worldmonitor-maps/country-boundary-overrides.geojson
   ```
5. No code changes needed — the app picks up the new geometry automatically

**Example script**: `scripts/fetch-pakistan-boundary-override.mjs` downloads the full Natural Earth 50m dataset (~24 MB), extracts Pakistan's feature, and writes the override file.

### Geopolitical Sensitivity

- Natural Earth shows **de facto** boundaries (who actually controls the territory), not diplomatic claims
- This is the same standard used by most mapping platforms
- When adding overrides for disputed territories, document the source and rationale in the PR description
- The override system does not add or remove territory — it replaces low-resolution outlines with higher-resolution ones from the same authoritative source

## Fallback Bounds

For regions where full polygon geometry may not be loaded, `ME_STRIKE_BOUNDS` in `country-geometry.ts` provides rectangular bounding boxes for Middle Eastern countries. `resolveCountryFromBounds()` uses these as a fast first pass, falling back to precise point-in-polygon when multiple bounding boxes overlap.

## Basemap Tiles

Basemap tile configuration lives in `src/config/basemap.ts`. See [MAP_ENGINE.md](MAP_ENGINE.md) for full details on tile providers (PMTiles, OpenFreeMap, CARTO), themes, and fallback behavior.

PMTiles are also served from R2 via `maps.worldmonitor.app`, configured through `VITE_PMTILES_URL`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using `pub-*.r2.dev` URLs in code | Always use `maps.worldmonitor.app` (CF-proxied) |
| Serving large GeoJSON from Vercel | Upload to R2 — Vercel bandwidth is expensive at scale |
| Fetching overrides without a timeout | Always use `AbortSignal.timeout` — override CDN may be slow or down |
| Forgetting `POLITICAL_OVERRIDES` | Check if the country code needs mapping (e.g., `CN-TW → TW`) |
| Adding aliases without checking existing | Check `NAME_ALIASES` and `nameToIso2` map first |
| Using `projection([lon, lat])` without NaN guard | d3 projections can return `[NaN, NaN]` (truthy) — always check with `Number.isFinite()` |
