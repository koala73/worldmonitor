#!/usr/bin/env node

// Canada ingest bundle.
//
// WHY A BUNDLE, NOT TEN SERVICES: the Canada pack (#6604-#6659) introduced
// seeders. Provisioned individually they would consume a Railway slot each against
// a fleet whose own runbook targets 65 services, for a combined measured tick
// cost of ~33s — 6% of this runner's 570s admission budget. #6670 already made
// the same call for BoC/StatCan by joining seed-bundle-macro rather than adding
// services. seed-bundle-regional is NOT the right home: it orchestrates LLM
// briefs and snapshots, a different domain from raw ingest crons.
//
// WHY THE CRON IS */5 WITH PER-MEMBER intervalMs: the runner gates each section
// on its own `intervalMs` against that section's seed-meta age, so a single
// service hosts members at different effective cadences. TTC and Toronto Fire
// CAD need 5 minutes; nothing else does. The remaining members declare the cadence their upstream
// actually justifies rather than inheriting TTC's.
//
// CADENCES ARE DELIBERATE, NOT INHERITED. Measured payloads per tick (live,
// 2026-08-14): Toronto 3.62MB, Ontario+Alberta 1.99MB, BC 0.87MB, VIA 0.30MB,
// TTC 27KB, Alberta alerts 12KB. Polling Toronto's construction-permit feed
// every 15 minutes cost 348 MB/day for data that changes on a permit desk's
// schedule; at 2h it costs ~44 MB/day. BC at 30min halves 84 MB/day. Together
// with the unchanged members that is ~938 -> ~394 MB/day.
//
// FAILURE SEMANTICS: every member runs through `runSeed`, whose fetch-phase
// catch preserves last-good and exits GRACEFUL_FETCH_FAILURE_EXIT_CODE (75).
// The runner counts 75 as a graceful skip and still exits 0, so an upstream
// flake — the realistic failure for all six — cannot red this service. What DOES
// red it is a hard non-zero exit or a SIGTERM timeout, which is why each member's
// timeoutMs is sized above its measured worst case rather than its median.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBundle, HOUR, MIN } from './_bundle-runner.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const CANADA_SECTIONS = [
  // Ontario, Alberta, and Manitoba share one vendor /api/v2/get adapter and one
  // seeder; each extra host is a config entry on the same script, publishing its
  // own key. Worst case is 7 endpoints x 3 runSeed attempts staggered 7s apart,
  // plus a possible 60s wait on the per-host 10-calls/60s token bucket. 240s
  // covers that with margin — if the limiter sleeps past the timeout the section
  // is SIGTERM'd, which is a HARD failure rather than runSeed's graceful path.
  { label: 'Provincial-511', script: 'seed-provincial-511.mjs', seedMetaKey: 'seed-meta:infra:ontario-511', canonicalKey: 'infra:ontario-511:v1', completionMetaKey: 'seed-completion:infra:ontario-511', intervalMs: 15 * MIN, timeoutMs: 240_000 },
  // 3.62MB body, not strictly valid JSON, sanitized then parsed. Road
  // restrictions are construction permits, not live incidents.
  { label: 'Toronto-Roads', script: 'seed-toronto-road-restrictions.mjs', seedMetaKey: 'seed-meta:infra:toronto-roads', canonicalKey: 'infra:toronto-roads:v1', intervalMs: 2 * HOUR, timeoutMs: 180_000 },
  // Open511 spec with next_url pagination; DriveBC returned the full active set
  // in one page, so budget one request per tick, not MAX_PAGES.
  { label: 'BC-Open511', script: 'seed-open511.mjs', seedMetaKey: 'seed-meta:infra:bc-open511', canonicalKey: 'infra:bc-open511:v1', intervalMs: 30 * MIN, timeoutMs: 120_000 },
  // Emergency alerts stay at 15 minutes: the payload is tiny and the whole point
  // of the layer is timeliness.
  { label: 'Alberta-Emergency-Alert', script: 'seed-alberta-emergency-alert.mjs', seedMetaKey: 'seed-meta:alerts:alberta-aea', canonicalKey: 'alerts:canada:alberta-aea:v1', completionMetaKey: 'seed-completion:alerts:alberta-aea', intervalMs: 15 * MIN, timeoutMs: 60_000 },
  // OGL-BC GeoJSON evacuation Alert/Order polygons. The seeder writes a
  // province snapshot, then rebuilds the same canadaAlerts union as Alberta.
  { label: 'BC-Emergency-Info', script: 'seed-bc-emergency-info.mjs', seedMetaKey: 'seed-meta:alerts:bc-emergency-info', canonicalKey: 'alerts:canada:bc-evacuation:v1', completionMetaKey: 'seed-completion:alerts:bc-emergency-info', intervalMs: 15 * MIN, timeoutMs: 60_000, dependsOn: ['Alberta-Emergency-Alert'] },
  { label: 'SaskAlert', script: 'seed-saskalert.mjs', seedMetaKey: 'seed-meta:alerts:saskalert', canonicalKey: 'alerts:canada:saskalert:v1', completionMetaKey: 'seed-completion:alerts:saskalert', intervalMs: 15 * MIN, timeoutMs: 60_000, dependsOn: ['BC-Emergency-Info'] },
  // Unofficial mobile JSON. 404 / shape-break degrades to sourceState
  // 'unavailable' and keeps last-good; it never raises SEED_ERROR.
  { label: 'VIA-Rail-Live', script: 'seed-viarail-live.mjs', seedMetaKey: 'seed-meta:transit:viarail-live', canonicalKey: 'transit:viarail:live', intervalMs: 15 * MIN, timeoutMs: 60_000 },
  // seed-meta key is `transit:ttc-alerts` because runSeed derives it from
  // (domain, resource) = ('transit', 'ttc-alerts'). It is NOT the canonical key
  // with :v1 stripped.
  { label: 'TTC-Alerts', script: 'seed-ttc-alerts.mjs', seedMetaKey: 'seed-meta:transit:ttc-alerts', canonicalKey: 'transit:ttc:alerts:v1', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  // Official TFS live CAD XML. Own key; 5min matches the source update cycle
  // and a durable activation marker makes the first-deploy health bridge strict
  // after the first successful canonical publish.
  { label: 'Toronto-TFS', script: 'seed-toronto-tfs.mjs', seedMetaKey: 'seed-meta:safety:toronto-tfs', canonicalKey: 'safety:toronto-tfs:v1', completionMetaKey: 'seed-completion:safety:toronto-tfs', intervalMs: 5 * MIN, timeoutMs: 60_000 },
  // Official TPS C4S_Public_NoGO FeatureServer. Own key; privacy exclusions
  // stay empty. 15min matches the 15–20min map refresh; stale at 45min.
  { label: 'Toronto-TPS', script: 'seed-toronto-tps.mjs', seedMetaKey: 'seed-meta:safety:toronto-tps', canonicalKey: 'safety:toronto-tps:v1', completionMetaKey: 'seed-completion:safety:toronto-tps', intervalMs: 15 * MIN, timeoutMs: 105_000 },
];

// This bundle is registered before its members merge, so on an intermediate
// tree some section scripts do not exist yet. A missing script would reach
// child_process.spawn and settle as a HARD failure, reddening the whole service
// for a member that was simply not deployed. Skip loudly instead: an absent
// script is a rollout state, a present-but-broken one is still a real failure.
const sections = CANADA_SECTIONS.filter((section) => {
  if (existsSync(join(here, section.script))) return true;
  console.warn(`[Bundle:Canada] SKIPPING ${section.label} — ${section.script} is not present in this deploy`);
  return false;
});

await runBundle('Canada', sections, {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work
  // and the terminal reason in logs.
  maxBundleMs: 570_000,
});
