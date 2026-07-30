---
title: Keep authority-gated cyclone sources out of production seed snapshots
date: 2026-07-14
category: integration-issues
module: Natural event seed pipeline
problem_type: integration_issue
component: background_job
symptoms:
  - "An experimental agency feed could be mistaken for an approved operational source"
  - "A single cyclone wind value could conceal incompatible agency averaging periods"
  - "An HKO tropical-cyclone signal can be useful before a named storm is available"
root_cause: missing_validation
resolution_type: seed_data_update
severity: high
tags: [natural-events, tropical-cyclones, hko, source-admission, railway-seeders]
---

# Keep authority-gated cyclone sources out of production seed snapshots

## Problem

Western-Pacific cyclone expansion needs authoritative attribution without turning
an experimental or unvetted agency endpoint into a production dependency. It
also needs to preserve each agency's reported wind averaging period rather than
collapsing unlike observations into one apparently comparable number.

## Symptoms

- An experimental CAP endpoint could be read as permission to enable JMA data.
- A local HKO warning can be operationally important even when it contains no
  named storm.
- A canonical event without agency-level fields would hide which wind value and
  averaging period came from which source.

## What Didn't Work

- Treating a published experimental data format as evidence that it is an
  operational production feed.
- Matching nearby named storms by coordinates alone; concurrent systems can be
  close together without representing the same cyclone.
- Copying a source wind into a canonical record without retaining its averaging
  period and agency identifier.

## Solution

Keep source admission, identity matching, and publication metadata explicit:

- `scripts/natural/western-pacific-cyclones.mjs` records JMA as
  `EXPERIMENTAL_CAP_NOT_OPERATIONAL` and JTWC as pending Railway preflight, so
  neither path is fetched or presented as an active source.
- The enabled HKO adapter permits only `https://data.weather.gov.hk`, rejects
  redirects, uses a 15-second timeout, and caps responses at 256 KiB before
  parsing JSON.
- `canonicalizeWesternPacificCyclones()` preserves one observation per
  `agency:agencyId`, matches aliases only inside bounded time and distance
  windows, and permits a much narrower proximity fallback only for unnamed
  observations. Named systems with distinct aliases do not merge.
- The `CycloneAgencyObservation` protobuf contract carries agency identifiers,
  status, wind, and wind-averaging period to the natural-event map popup.
- `seed-natural-events.mjs` publishes separate western-Pacific and HKO snapshots
  with `seed-meta:*` records; the Railway climate bundle runs the seed every
  three hours.

## Why This Works

The seed makes the admission decision visible in its snapshot instead of
silently degrading authority. A JMA or JTWC source cannot become live merely
because an adapter shape exists. HKO remains independently useful when JMA is
blocked, while the canonical event keeps the source-specific wind semantics
visible to map users.

## Prevention

- Require an explicit source-decision record, Railway transport preflight, and
  bounded host policy before enabling a new external seeder host.
- For multi-agency meteorological observations, keep the agency identifier and
  averaging period on every observation; never infer equivalence from a shared
  storm name alone.
- Cover alias matching, nearby distinct storms, agency-scoped cancellation,
  HKO unnamed warnings, host/redirect/response limits, and the generated API
  contract in regression tests.

## Related Issues

- Fixes #5276.
- [Railway seeder watch paths can skip deployments](railway-seeder-watch-paths-can-skip-deployments.md)
