#!/usr/bin/env node
/**
 * One-shot migration: existing `(digestMode='realtime', sensitivity='high')`
 * rows in `alertRules` are no longer representable post-PR-#3474. Existing
 * rows in that state were grandfathered in (the validator only checks on
 * write), but those users can no longer update their settings via
 * setAlertRules / setDigestSettings — `resolveEffectivePair` reads existing
 * sensitivity='high' on a partial update and trips assertCompatibleDeliveryMode.
 *
 * This driver moves them to `(daily, high)` — the choice confirmed during
 * PR #3474's review. Realtime users who specifically want realtime delivery
 * have already been moved to `(realtime, critical)` if they opted in
 * explicitly; the rest stay as digest users.
 *
 * Usage:
 *   1. Source prod env: `set -a; source ../../../.env.local; set +a` (or
 *      `set -a; source <main-repo>/.env.local; set +a`). Required env vars:
 *      CONVEX_URL, CONVEX_DEPLOY_KEY.
 *
 *   2. Discovery (dry-run, default):
 *      `node scripts/migrate-realtime-high-to-daily.mjs`
 *      Prints affected count + JSON list. No mutations.
 *
 *   3. Apply:
 *      `node scripts/migrate-realtime-high-to-daily.mjs --apply`
 *      For each affected row, calls
 *      `npx convex run alertRules:setNotificationConfigForUser '{...}'`
 *      (the atomic pair-update from PR #3461 — accepts both digestMode and
 *      sensitivity in a single mutation; setDigestSettingsForUser would NOT
 *      work because its validator has no `sensitivity` arg) with
 *      `digestMode: "daily", sensitivity: "high"`. Tracks success / failure,
 *      exits non-zero if any failed.
 *
 * Safety:
 *   - Idempotent: a row already at `(daily, high)` won't appear in the
 *     filter and will be skipped.
 *   - The mutation it calls (`setNotificationConfigForUser`) is internal +
 *     deploy-key-gated, so this script can only run with prod deploy
 *     credentials. There is no path to call it without auth.
 *   - Per-row failures are logged and counted but don't abort the loop —
 *     we want as many migrated as possible in one pass; ops can re-run for
 *     the failed subset.
 *
 * Why a script vs. dashboard click-through:
 *   Audit trail. The committed PR + script + this comment block + the
 *   stdout log of the run is the operator-facing record of exactly which
 *   userIds were touched and why.
 */

import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL;
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY;
if (!CONVEX_URL) {
  console.error("[migrate-realtime-high] CONVEX_URL env var required");
  process.exit(2);
}
if (!CONVEX_DEPLOY_KEY) {
  console.error(
    "[migrate-realtime-high] CONVEX_DEPLOY_KEY env var required (for `npx convex run` calls)",
  );
  process.exit(2);
}

const APPLY = process.argv.includes("--apply");

console.log(`[migrate-realtime-high] target: ${CONVEX_URL}`);
console.log(`[migrate-realtime-high] mode:   ${APPLY ? "APPLY (mutating)" : "discovery (dry-run)"}`);
console.log("");

const client = new ConvexHttpClient(CONVEX_URL);

let allEnabled;
try {
  allEnabled = await client.query(api.alertRules.getByEnabled, { enabled: true });
} catch (err) {
  console.error(`[migrate-realtime-high] getByEnabled failed: ${err.message}`);
  process.exit(3);
}

// Effective digestMode: per relay (`scripts/notification-relay.cjs`),
// `rule.digestMode ?? "realtime"` — undefined is treated identically to
// "realtime". This filter MUST mirror that, otherwise rows with undefined
// digestMode (the silent third case from PR #3461 review) are missed.
const affected = allEnabled.filter((r) => {
  const effectiveDigestMode = r.digestMode ?? "realtime";
  return effectiveDigestMode === "realtime" && r.sensitivity === "high";
});

// Diagnostic breakdown so a future operator can see the population shape
// at the time of run, not just the matching subset.
const breakdown = {};
for (const r of allEnabled) {
  const effectiveDigestMode = r.digestMode ?? "realtime";
  const key = `${r.digestMode === undefined ? "<undefined>" : r.digestMode}/${r.sensitivity ?? "<undefined>"} (effective=${effectiveDigestMode})`;
  breakdown[key] = (breakdown[key] ?? 0) + 1;
}
console.log("[migrate-realtime-high] population breakdown (digestMode/sensitivity):");
for (const [key, count] of Object.entries(breakdown).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${key}`);
}
console.log("");

console.log(
  `[migrate-realtime-high] enabled rules total: ${allEnabled.length}; affected (effective realtime, high): ${affected.length}`,
);

if (affected.length === 0) {
  console.log("[migrate-realtime-high] nothing to migrate, exiting.");
  process.exit(0);
}

const summary = affected.map((r) => ({
  userId: r.userId,
  variant: r.variant,
  digestMode: r.digestMode,
  sensitivity: r.sensitivity,
}));
console.log("[migrate-realtime-high] affected rows:");
console.log(JSON.stringify(summary, null, 2));

if (!APPLY) {
  console.log(
    "\n[migrate-realtime-high] dry-run complete. Re-run with --apply to migrate to (daily, high).",
  );
  process.exit(0);
}

console.log("\n[migrate-realtime-high] applying migration...");
let migrated = 0;
let failed = 0;
const failures = [];

for (const row of affected) {
  const args = JSON.stringify({
    userId: row.userId,
    variant: row.variant,
    digestMode: "daily",
    sensitivity: "high",
  });
  // setDigestSettingsForUser only accepts digest-related fields, not
  // sensitivity. Use setNotificationConfigForUser — the atomic pair-update
  // mutation added in PR #3461 — which validates the (digestMode,
  // sensitivity) pair via assertCompatibleDeliveryMode before patching.
  const result = spawnSync(
    "npx",
    ["convex", "run", "alertRules:setNotificationConfigForUser", args],
    {
      env: {
        ...process.env,
        CONVEX_URL,
        CONVEX_DEPLOY_KEY,
      },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  if (result.status === 0) {
    console.log(`✓ ${row.userId} / ${row.variant}`);
    migrated++;
  } else {
    const msg = (result.stderr || result.stdout || "").trim().split("\n").slice(-3).join(" | ");
    console.error(`✗ ${row.userId} / ${row.variant}: ${msg}`);
    failed++;
    failures.push({ userId: row.userId, variant: row.variant, error: msg });
  }
}

console.log(
  `\n[migrate-realtime-high] done. migrated=${migrated} failed=${failed}`,
);
if (failed > 0) {
  console.log("[migrate-realtime-high] failures:");
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
process.exit(0);
