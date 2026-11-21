---
module: src/config/trade-routes, server/_shared/chokepoint-registry, scripts/seed-hs2-chokepoint-exposure, scripts/shared/country-port-clusters
date: 2026-11-01
problem_type: logic_error
component: data_model
severity: medium
issue: 7990
symptoms:
  - The route explorer draws a tanker lane through the Panama Canal and lists no chokepoint for it
  - Supplier route risk names Panama for a pair while the explorer and the seeded exposure ignore it
  - Adding one route to a chokepoint moves the exposure scores of countries that never use that route
tags: [trade-routes, chokepoint-registry, route-explorer, exposure, panama]
---

# A route that crosses a chokepoint must also be in its registry entry

## Problem

Two sources say which routes cross a chokepoint:

| Source | Read by |
| --- | --- |
| `TRADE_ROUTES[].waypoints` in `src/config/trade-routes.ts` | Supplier route risk (`src/utils/supplier-route-risk.ts`) and lane geometry |
| `routeIds` on each chokepoint in the three registries: `server/_shared/chokepoint-registry.ts`, `src/config/chokepoint-registry.ts` and the copy inside `scripts/seed-hs2-chokepoint-exposure.mjs` | Route explorer chokepoints and bypasses, route impact, route intelligence and seeded HS2 exposure |

When #7990 added `us-gulf-asia-panama` with a `panama` waypoint but left Panama's `routeIds` unchanged, US→JP tanker in the explorer chose that route. Its geometry crossed the canal, but it showed no chokepoint and no bypass. Supplier risk still showed Panama because it reads waypoints.

## Why leaving the registry alone looked attractive

Seeded exposure divides by the registry size: `routeCoverage = overlap / cp.routeIds.length`. Panama had two routes, so a third route moves every Panama score:

- Countries already on a Panama route drop: China HS26 goes from 61.2 to 40.8, and Nicaragua HS26 from 100 to 66.7.
- Countries on the new route rise: Japan HS10 goes from 37.5 to 58.1.

Across 2,787 country × HS2 cells measured from production bilateral data on 2026-11-01, 1,979 Panama values changed and 854 moved by 5 points or more.

The exposure seeder and its handler count a route when the importer *or* the exporter uses it (union coverage). So once Japan's cluster lists a Panama route, every Japanese import gets a Panama baseline of about 1/3, whatever its origin. That is the same baseline the model already gives Hormuz and the Cape for Japanese vegetable oils, which also cross neither.

## Resolution

Keep the two sources equal and accept the denominator change as the meaning of the metric. A route that crosses a chokepoint goes into all three `routeIds` lists. `tests/route-explorer-lane.test.mts` ("route waypoints and chokepoint registries agree") fails when:

- a waypoint route is missing from its chokepoint's `routeIds`;
- a `routeIds` entry names a route whose waypoints do not include that chokepoint;
- the browser or seeder `routeIds` drift from the server registry.

If the union baseline becomes the problem, change the exposure model to count shared routes only (importer *and* exporter), as supplier risk and the explorer already do. Do not fix it by leaving a registry incomplete.

## Checks before adding a route

1. Run `tests/route-explorer-lane.test.mts` and `tests/supplier-route-risk.test.mjs`.
2. Probe `computeLane` for the new pairs with every cargo type: `container`, `tanker`, `bulk` and `roro`. Energy cargo is `tanker`; there is no `energy` cargo type, and the explorer falls back to `container` for unknown values.
3. Recompute seeded exposure from production bilateral keys, before and after, and report the changed cell count and the largest moves.
4. Run `npm run generate:check`. The TUI catalog embeds routes and chokepoint route lists.
5. Commit before running the country brief e2e suite. Its evidence step runs `git diff HEAD` with the default 1 MB buffer, and an uncommitted change to the single-line catalog fails every test with `spawnSync git ENOBUFS`.
