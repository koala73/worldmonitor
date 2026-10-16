---
title: Keep IMD cyclone and marine products typed and unflattened
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

# Keep IMD cyclone and marine products typed and unflattened

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

- The original API seeder in `scripts/lib/imd-cyclone-marine.mjs` qualified
  each product, failed closed on undocumented fishermen warning, and kept
  observed positions, forecast positions, forecast-wind-radii, and
  cone-of-uncertainty as distinct `geometryKind` values.
- One failed product carries last-good for that product only.
- Dashboard hydration is the on-demand bootstrap key `imdCycloneMarine`.

## Update 2026-10-16: public bulletin pages replace the API (#7730)

IMD binds each production API key to one server IPv4. Railway gives the
seeder 3 outbound addresses, so the key-gated path never ran. The seeder now
parses the public pages on `mausam.imd.gov.in` instead:

- Sea-area bulletins `Forecast/seaarea_bulletin_new.php?id=1` (Bay of Bengal)
  and `?id=4` (Arabian Sea). Other IDs return the Bay of Bengal bulletin.
- Coastal bulletins `Forecast/coastal_bulletin_new.php` (West Bengal and
  Andaman) and `?id=2` to `?id=7`. Port signals arrive here. The NAVTEX copies
  redirect to a login page.
- The IDs come from the index pages `responsive/marine_forecast.php` and
  `responsive/coastal_forecast.php`. Their links are relative to
  `/responsive/`, so `../Forecast/` resolves to `/Forecast/`.

Each page fails closed on its own. A missing title, validity line, issue time,
storm-warning row, or area field rejects the page and carries that page's
last-good records. An expired page publishes nothing but still counts as a
healthy reply. Cyclone track, wind radii, and cone stay disabled as API-only
(`API_ONLY_COVERED_BY_GDACS`). Port warnings and fishermen warnings are PDFs
and stay disabled. The RTI non-commercial rights record applies to the public
pages too.

## Related Issues

- Fixes #7005.
- Supersedes the fixed-egress proxy plan in #7730.
- Does not implement #7004 (district/nowcast) or #7002 (NDMA SACHET).
