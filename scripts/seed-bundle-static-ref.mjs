#!/usr/bin/env node
import { runBundle, DAY, WEEK } from './_bundle-runner.mjs';

// The LIGHT half of static-ref. The three expensive members (Arms-Suppliers,
// Military-Bases, Mineral-Production) moved to seed-bundle-static-ref-heavy in
// #6806 because they could not coexist with the remaining members under one 570s tick.
//
// What that split buys, and why it is worth a Railway service: the five members
// below now total 545s of worst-case reservation (110 + 100 + 190 + 70 + 75)
// against a 570s budget. The runner performs the heartbeat and every freshness
// gate concurrently inside a bounded 20s preflight, leaving 5s for process
// overhead. Every due member is therefore admissible on every tick. There is no
// ordering question left in this bundle and no member can starve another. Before the split,
// Arms-Suppliers measured 371s here and left 199s, which deferred Defense-Patents
// and Mineral-Production by 13 seconds on 2026-08-18 — Mineral-Production on the
// very tick its acknowledgement expired.
//
// Keep this total under 570s. Adding a member whose reservation does not fit
// alongside the others reintroduces the ordering question this split removed.
await runBundle('static-ref', [
  // Keep the two upstreams as separate processes. A World Bank failure cannot
  // prevent a healthy SIPRI publication, and the daily tick lets the wall-time
  // budget defer lower-priority members without missing their real cadence.
  { label: 'Defense-Industrial', script: 'seed-defense-industrial.mjs', seedMetaKey: 'military:defense-industrial', canonicalKey: 'military:industrial-base:v1', intervalMs: 10 * DAY, timeoutMs: 100_000 },
  // 90s, not 300s. The runner admits on the DECLARED worst case
  // (timeoutMs + KILL_GRACE_MS) because it decides before running, so a timeout
  // is a reservation rather than a ceiling drawn down on use — and 300s asked
  // for a 310s slot to do work that measures ~22s. With 293s left after
  // Arms-Suppliers it was refused by 17 seconds on every tick, which is why
  // infrastructure:submarine-cables:v1 had never existed (#6799). It first
  // published 2026-08-18T03:07:44Z with 86 cables, 22s after it started.
  //
  // Measured 2026-08-17 against submarinecablemap.com: the seeder fetches the
  // CURATED list (CABLE_REGIONS, 86 cables) rather than the 702 in all.json —
  // 18 batches of 5 at ~0.97s, plus ~5s for cable-geo.json (739KB) and
  // landing-point-geo.json (360KB). 90s is ~4x that, which keeps room for a
  // slower link from Railway while reserving 100s instead of 310s.
  { label: 'Submarine-Cables', script: 'seed-submarine-cables.mjs', seedMetaKey: 'infrastructure:submarine-cables', canonicalKey: 'infrastructure:submarine-cables:v1', intervalMs: WEEK, timeoutMs: 90_000 },
  { label: 'Defense-Patents', script: 'seed-defense-patents.mjs', seedMetaKey: 'military:defense-patents', canonicalKey: 'patents:defense:latest', intervalMs: WEEK, timeoutMs: 180_000, requiredEnv: ['USPTO_API_KEY'] },
  { label: 'Chokepoint-Baselines', script: 'seed-chokepoint-baselines.mjs', seedMetaKey: 'energy:chokepoint-baselines', canonicalKey: 'energy:chokepoint-baselines:v1', intervalMs: 400 * DAY, timeoutMs: 60_000 },
  // The data changes annually, but the 20-day refresh interval keeps the
  // deliberately short 30-day canonical TTL alive. A mixed last-good publish
  // still stamps seed-meta now, so the completion marker is the only signal
  // that all three stages were fresh. Without it the daily tick retries
  // instead of sleeping ~16 days on a partial stack.
  { label: 'Demographics-Capability', script: 'seed-demographics-capability.mjs', seedMetaKey: 'demographics:capability', canonicalKey: 'demographics:capability:v1', freshnessMetaKey: 'seed-meta:demographics:capability', completionMetaKey: 'seed-meta:demographics:capability-complete', requireCanonical: true, intervalMs: 20 * DAY, timeoutMs: 65_000 },
], { maxBundleMs: 570_000, prefetchFreshness: true });
