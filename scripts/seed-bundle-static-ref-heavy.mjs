#!/usr/bin/env node
import { runBundle, DAY } from './_bundle-runner.mjs';

// The heavy half of static-ref (#6806). These three members are low-cadence
// but expensive, and leftover's 570s tick could not hold them alongside the
// light members: Arms-Suppliers alone measured 371s on 2026-08-18, which left
// 199s and deferred Mineral-Production by 13 seconds on a tick where its
// acknowledgement had just expired.
//
// ONE service, not three. Railway kills a cron container at 10 minutes, so the
// budget is 570s and no arrangement can run Arms-Suppliers (460s worst case)
// and Military-Bases (410s) in the SAME tick. But "cannot share a tick" is not
// "cannot share a bundle": the runner defers the loser to the next daily tick,
// and at 10-day and 30-day cadences a one-day deferral costs nothing. Three
// 1-section services would have bought the same isolation at 3x the Railway
// service budget, which is capped at 100 and already at 81.
//
// Ordering ROTATES because a member that never publishes never stops being due.
// That is not hypothetical here: Arms-Suppliers has never written
// seed-meta:military:arms-suppliers-complete, so a fixed order would hand it
// the first slot every single day and reproduce, inside this bundle, the exact
// starvation that made it necessary. seed-bundle-macro.mjs uses the same device
// for the same reason (its education member gets first priority one UTC day a
// week). With three members on a daily tick, each one leads every third day —
// far more often than any of these cadences needs, so a permanently failing
// member can consume at most one lead slot in three.
const SECTIONS = [
  // Cheapest first in the canonical order: on the two days it does not lead it
  // still fits behind either heavy (371s + 190s = 561s, 335s + 190s = 525s).
  { label: 'Mineral-Production', script: 'seed-mineral-production.mjs', seedMetaKey: 'supply-chain:mineral-production', canonicalKey: 'supply-chain:mineral-production:v1', intervalMs: 60 * DAY, timeoutMs: 180_000 },
  { label: 'Arms-Suppliers', script: 'seed-defense-industrial-suppliers.mjs', seedMetaKey: 'military:arms-suppliers-complete', canonicalKey: 'military:arms-suppliers:complete:v1', intervalMs: 10 * DAY, timeoutMs: 450_000 },
  // Missing canonicalKey is intentional (#6845); do not invent one here.
  { label: 'Military-Bases', script: 'seed-military-bases.mjs', seedMetaKey: 'military:bases', intervalMs: 30 * DAY, timeoutMs: 400_000 },
];

// Days since epoch, not getUTCDay(): the rotation must advance by exactly one
// per tick. A 7-day clock read modulo 3 would jump 7%3=1 per week but stutter
// across the week boundary, giving one member two consecutive lead days.
const dayIndex = Math.floor(Date.now() / 86_400_000);
const offset = dayIndex % SECTIONS.length;
const sections = [...SECTIONS.slice(offset), ...SECTIONS.slice(0, offset)];

console.log(
  `[Bundle:static-ref-heavy] rotation offset ${offset} — order: ${sections.map((s) => s.label).join(' -> ')}`,
);

await runBundle('static-ref-heavy', sections, {
  // Railway kills cron containers at 10 minutes. Defer sections whose full
  // timeout plus SIGTERM/SIGKILL grace cannot fit, preserving completed work
  // and the terminal reason in logs.
  maxBundleMs: 570_000,
});
