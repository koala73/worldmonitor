# public/data — self-hosted static geodata

Files here are served same-origin at `/data/*`. `vercel.json` applies
`Cache-Control: public, max-age=31536000, immutable` to `/data/(.*)`, so these
filenames are effectively content-pinned — **bump the filename (or relax the
cache rule) if a file's contents ever change**, otherwise returning visitors
keep the stale copy for up to a year.

## Map atlas (TopoJSON)

| File | Upstream source | Regenerate |
|------|-----------------|------------|
| `countries-50m.json` | npm [`world-atlas@2`](https://www.npmjs.com/package/world-atlas) → `countries-50m.json` | `cp node_modules/world-atlas/countries-50m.json public/data/` |
| `countries-110m.json` | npm [`world-atlas@2`](https://www.npmjs.com/package/world-atlas) → `countries-110m.json` | `cp node_modules/world-atlas/countries-110m.json public/data/` |

Consumed by `src/components/Map.ts` (the d3/SVG map) via `MAP_URLS` in
`src/config/geo-map.ts`. Previously fetched from
`cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json`; self-hosted to drop the
third-party origin from the mobile map's critical path (PR #4383, issue #4374).

**Mobile uses `countries-110m.json`** (≈86% fewer arc points → lower `styleLayout`;
#4443 U6) via `worldTopologyUrl(isMobile)`; desktop keeps `countries-50m.json`. The
110m topology has 177 country geometries vs the 50m's 241 — it omits 64 micro-state /
territory base-map **outlines** (e.g. Bahrain, Singapore, Hong Kong, Malta, Maldives).
This is an accepted tradeoff: event overlays are positioned by lat/lon independently of
the base polygons, and the omitted outlines are near-invisible at mobile zoom.
