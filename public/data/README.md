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

Consumed by `src/components/Map.ts` (mobile d3/SVG globe) via `MAP_URLS.world`
in `src/config/geo.ts`. Previously fetched from
`cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json`; self-hosted to drop the
third-party origin from the mobile map's critical path (PR #4383, issue #4374).
