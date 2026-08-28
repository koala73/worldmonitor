---
title: Keep IMD cyclone and marine products typed, key-gated, and unflattened
date: 2026-08-27
category: integration-issues
module: Weather and natural seed pipeline
problem_type: integration_issue
component: background_job
symptoms:
  - "An IMD 401 or empty cyclone season could be read as an India all-clear"
  - "Forecast wind radii or a cone of uncertainty could be drawn as an observed storm footprint"
  - "Port signals and sea-area bulletins could disappear into generic NWS weather alerts"
root_cause: missing_validation
resolution_type: seed_data_update
severity: high
tags: [weather, tropical-cyclones, imd, marine-warnings, source-admission, railway-seeders]
---

# Keep IMD cyclone and marine products typed, key-gated, and unflattened

## Problem

Issue #7005 adds India Meteorological Department cyclone tracks, forecast wind
radii, cones of uncertainty, port warnings, and sea-area / coastal bulletins.
Those products do not share one geometry or one all-clear meaning, and the
public API is account- and key-gated.

## What Didn't Work

- Merging IMD rows into `weather:alerts:v1`. That flattens a port signal, a
  textual marine bulletin, and a forecast cone into the same NWS/ECCC/SWIC
  alert card.
- Treating fishermen warning as live because the index lists `#api-23`. The
  public reference HTML has no field section (sections end at `#api-20`).
- Treating HTTP 401 or a quiet cyclone season as "no warning in India".

## Solution

- `scripts/lib/imd-cyclone-marine.mjs` qualifies each product, fail-closes
  undocumented fishermen warning, and keeps observed positions, forecast
  positions, forecast-wind-radii, and cone-of-uncertainty as distinct
  `geometryKind` values.
- Live fetch requires `IMD_API_KEY`. Without it, the seeder publishes
  `coverageState: disabled` with `sourceState:
  unavailable` (not all-clear).
- One failed product carries last-good for that product only.
- Dashboard hydration is the on-demand bootstrap key `imdCycloneMarine`.

## Related Issues

- Fixes #7005.
- Does not implement #7004 (district/nowcast) or #7002 (NDMA SACHET).
