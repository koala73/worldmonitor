---
title: Country Scope filter's permissive default leaked every unattributed alert category
date: 2026-07-18
category: logic-errors
module: notification-relay
problem_type: logic_error
component: background_job
severity: high
symptoms:
  - "User scoped to 10 Eastern-European countries received CRITICAL alerts for São Paulo/Hong Kong/Kuala Lumpur/Guangzhou airport disruptions"
  - "VIX surge (Commodity Market) and Sudan conflict casualties (UCDP) delivered despite neither matching the configured Country Scope"
  - "Existing country-filter test suite stayed green throughout — it asserted the filter's own semantics, not delivery outcomes for real publisher payloads"
root_cause: logic_error
resolution_type: code_fix
related_components: [service_object, testing_framework]
tags: [notifications, country-scope, fail-open, denylist-vs-allowlist, attribution, normalization, mutation-testing]
---

# Country Scope filter's permissive default leaked every unattributed alert category

## Problem

The notification relay's per-rule Country Scope filter treated events without
country attribution as "deliver to everyone" unless their type was on a
two-entry denylist. Since most publishers attached no attribution — and one
publisher's attribution silently failed — a user who restricted alerts to 10
countries received critical alerts from three unrelated categories (aviation,
markets, conflict data). Reported in #5359, fixed in PR #5366.

## Symptoms

- Country Scope `[CZ, LV, LT, EE, PL, UA, XK, RS, BY, RU]` + sensitivity
  "Critical only" still delivered: `aviation_closure` for GRU/HKG/KUL/CAN,
  `market_alert` for a VIX surge, and `conflict_escalation` for Sudan.
- The user's report correctly inferred the mechanism: "Country Scope filtering
  is only applied to certain alert types … not consistently enforced across
  all notification sources."

## What Didn't Work (as protection)

- **The denylist patch (#4737).** An earlier report of the same shape was
  fixed by adding the two offending event types (`corridor_risk`,
  `shipping_stress`) to an `UNATTRIBUTED_GLOBAL_EVENT_TYPES` denylist. That
  fixed those two types and silently re-exposed the bug for every *other*
  unattributed type — the fix hardened instances, not the default.
- **The mirror test.** `tests/notification-relay-country-filter.test.mjs`
  re-implemented the filter as a local copy plus a source-grep contract. It
  verified the filter's *own* semantics (which were "working as coded") but
  never fed it what publishers actually emit — payloads with no
  `countryCode` — against a scoped rule, so the leak was invisible to it.
- **Spot-check aliases in the name map.** The shared name→ISO2 helper had 12
  entries and tests asserting `UK`/`USA`/`UAE` resolved. The covered cases
  passed while ~290 country names (including `Sudan`) returned `null`.

## Root Cause

Three layers compounded, and each hid the others:

1. **Fail-open default** — `eventMatchesCountryScope` in
   `scripts/notification-relay.cjs` returned `true` for any event without
   resolvable attribution unless its type was denylisted. New event types and
   publishers joined the leak by default.
2. **Publishers omitted attribution they had** — `scripts/seed-aviation.mjs`
   built `aviation_closure`/`notam_closure` payloads from an airport registry
   whose rows carry `country: 'Brazil' | 'China' | …` but never attached it.
3. **Silent normalization miss** — `scripts/ais-relay.cjs` UCDP/cyber
   publishers *did* look up a code
   (`const countryCode = normalizeNotificationCountryCode(e.country)`,
   `scripts/ais-relay.cjs:1739`) and then spread
   `...(countryCode ? { countryCode } : {})` — so a `null` from the 12-entry
   stub map silently deleted the attribution, dropping the event into the
   permissive branch. A lookup miss and a genuinely-global event were
   indistinguishable downstream.

## Solution

Inverted the default and repaired both attribution paths (all cites at PR
#5366's head):

- **Default DROP with an explicit allowlist**
  (`scripts/notification-relay.cjs:704-778`): unattributed events now match a
  scoped rule only if their type is in
  `PERMISSIVE_UNATTRIBUTED_EVENT_TYPES` — news origins (`rss_alert`,
  `keyword_spike`, `hotspot_escalation`, `military_surge`; RSS still has no
  reliable attribution and scoped users shouldn't lose keyword-relevant news)
  plus `watchlist_story_alert` (scoped by ticker instead, an explicit
  opt-in).
- **Region-scoped events match via membership**
  (`regionalEventMatchesCountryScope`,
  `scripts/notification-relay.cjs:724-730`): `regional_*` events carry
  `payload.region_id`, so a scoped rule matches when any of its countries
  maps into that region via `shared/iso2-to-region.json`.
- **Attribution at the publisher**: `scripts/seed-aviation.mjs:886` resolves
  the alert row's country name; `:917` resolves NOTAM ICAOs through the
  airport registry. The browser path forwards `countryCode` too
  (`src/services/breaking-news-alerts.ts`, OREF sirens → `IL`).
- **Complete name map**: `scripts/shared/country-name-to-iso2.cjs` is now
  backed by the full ~306-entry `shared/country-names.json` with the same
  key-normalization as `scripts/build-country-names.cjs`, UCDP
  historical-parenthetical stripping (`Yemen (North Yemen)` → `YE`), and a
  `bosnia herzegovina` alias. The root `shared/` duplicate copy was synced in
  the same commit.
- **Container guard extended**: the new JSON data deps are COPY'd in
  `Dockerfile.relay`, and `tests/dockerfile-relay-imports.test.mjs` now
  tracks `require()`'d `.json` files — the guard caught the missing COPY
  during development (a missing data file is a startup crash, exactly like a
  missing `.cjs`).

## Why This Works

With DROP as the default, an unknown or attribution-less event type fails
*closed* for scoped users: the worst regression a future publisher can cause
is an over-filtered alert (visible, complainable), not a silent leak
(invisible until a user files a bug). The allowlist is small, documented, and
each entry carries its own justification — the reviewable artifact is "why is
this type allowed to bypass scope," not "did anyone remember to denylist the
new type."

## Prevention

- **Scope/permission filters default closed.** A per-item filter with a
  permissive default plus a maintained denylist silently fails open for every
  new case; each incident produces another denylist patch (#4737 → #5359).
  Invert once: default-DROP, explicit allowlist, one justification comment
  per entry.
- **A normalization helper returning `null` on miss must not silently erase
  data.** The `...(code ? { code } : {})` spread pattern converts "lookup
  failed" into "field never existed." Either make the map complete (back it
  with the canonical dataset instead of a hand-typed stub) or make the miss
  observable before the field is dropped.
- **Test the registered function against real payloads.** Export the filter
  and exercise the actual export with what publishers actually emit — the
  regression suite (`tests/notification-relay-country-scope-5359.test.mjs`)
  loads the real relay module via a `Module._load` stub and replays the
  reporter's exact rule against all three leaked categories.
- **Mutation-test multi-part fixes.** Each of the three fixes was reverted
  individually to confirm the suite goes red for each — proving no single
  layer's tests were riding on another layer's fix.

## Related Issues

- #5359 (this bug), PR #5366 (the fix; this doc ships with it), #4737 (the
  earlier denylist patch for the same structural flaw), #3632 (original
  country-scoping feature)
- `docs/solutions/logic-errors/health-must-not-grade-an-unconfigured-optional-source.md`
  — sibling lesson on distinguishing "absent by design" from "absent by
  failure"; here the same conflation (unattributed vs. global) drove the
  permissive default.
