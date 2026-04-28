#!/usr/bin/env node
/**
 * One-shot cleanup: disable notifications for all `alertRules` rows that
 * belong to free-tier (`tier === 0`) users.
 *
 * Why this exists:
 *   A 2026-04-28 audit found 7 of 28 enabled `alertRules` rows belonged to
 *   free-tier users despite the UI paywall. Those users got rows in via
 *   either a past UI gate hole, direct API call, or a deeplink/A-B-test
 *   bypass. The relay's PRO filter (layer 3) has been silently dropping
 *   their notifications at delivery time, but the rows still exist with
 *   `enabled: true`. This script flips them to `enabled: false`.
 *
 * Sequencing — RUN ONLY AFTER:
 *   - PR #3483 (server-side mutation gate) deployed.
 *   - PR #3485 (relay fail-closed) deployed.
 *   Otherwise, the same users could re-enable through the still-open
 *   write surface tomorrow. The user explicitly stated: "close it first,
 *   before doing anything to free users."
 *
 * Mechanism:
 *   Calls `internal.alertRules.setAlertRulesForUser` (the UNGATED operator
 *   path — see PR #3483 contract test) with `enabled: false`. CRITICAL:
 *   `setAlertRulesForUser` PATCHES `eventTypes` and `channels` (does NOT
 *   preserve), so we MUST pass through the row's existing values via
 *   `row.eventTypes` and `row.channels`. Omitting them or sending `[]`
 *   would wipe the user's saved subscriptions/channels — if they later
 *   upgrade to PRO they'd reconfigure from scratch (Greptile P1 round 1).
 *
 * Fail-closed on entitlement-lookup errors:
 *   If ANY `npx convex run entitlements:getEntitlementsByUserId` call
 *   returns a non-zero exit, OR fails to produce a parseable tier/planKey,
 *   the script ABORTS without cleaning up anything. Silent failure
 *   (treating unknown tier as 0 or -1) would let an environment regression
 *   masquerade as "no free users found" — better to refuse to touch any
 *   data when the audit predicate is unreliable (Greptile P1 round 1).
 *
 * Multi-variant correctness:
 *   The entitlement lookup is per-userId (deduped). The cleanup target
 *   list is built from ALL rows whose userId resolves to tier=0 — so a
 *   free user with multiple variants gets ALL of them disabled in one
 *   pass, not just the first variant the dedupe loop saw.
 *
 * Usage:
 *   1. Source prod env (CONVEX_URL + CONVEX_DEPLOY_KEY required).
 *   2. Discovery (default): `node scripts/disable-free-user-notifications.mjs`
 *      Prints population breakdown + per-row free-tier list. No mutations.
 *   3. Apply: `node scripts/disable-free-user-notifications.mjs --apply`
 *      Flips `enabled: false` for each free-tier row, preserving every
 *      other field. Per-row failures logged + counted; exit 1 if any failed.
 *
 * Idempotent: re-running after apply finds 0 free-tier rows in the enabled
 * set (because `enabled: false` rows are excluded from `getByEnabled`).
 */

import { spawnSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../convex/_generated/api.js";

const CONVEX_URL = process.env.CONVEX_URL;
const CONVEX_DEPLOY_KEY = process.env.CONVEX_DEPLOY_KEY;
if (!CONVEX_URL) {
  console.error("[disable-free-notif] CONVEX_URL env var required");
  process.exit(2);
}
if (!CONVEX_DEPLOY_KEY) {
  console.error(
    "[disable-free-notif] CONVEX_DEPLOY_KEY env var required (for `npx convex run` calls)",
  );
  process.exit(2);
}

const APPLY = process.argv.includes("--apply");

console.log(`[disable-free-notif] target: ${CONVEX_URL}`);
console.log(
  `[disable-free-notif] mode:   ${APPLY ? "APPLY (mutating)" : "discovery (dry-run)"}`,
);
console.log("");

const client = new ConvexHttpClient(CONVEX_URL);

let allEnabled;
try {
  allEnabled = await client.query(api.alertRules.getByEnabled, { enabled: true });
} catch (err) {
  console.error(`[disable-free-notif] getByEnabled failed: ${err.message}`);
  process.exit(3);
}

console.log(`[disable-free-notif] enabled alertRules rows: ${allEnabled.length}`);

// Build a tierByUserId map. ONE lookup per unique userId (entitlement is
// per-user, not per-variant). Fail-closed on ANY lookup failure: partial-
// knowledge cleanup is worse than no cleanup at all.
const tierByUserId = new Map();
const planByUserId = new Map();
const uniqueUserIds = [...new Set(allEnabled.map((r) => r.userId))];

for (const userId of uniqueUserIds) {
  const result = spawnSync(
    "npx",
    ["convex", "run", "entitlements:getEntitlementsByUserId", `{"userId":"${userId}"}`],
    { env: process.env, encoding: "utf-8", timeout: 30_000 },
  );
  if (result.status !== 0) {
    console.error(
      `[disable-free-notif] FATAL: entitlement lookup for ${userId} exited ${result.status}. ` +
        `Refusing to proceed with partial knowledge — fix the lookup path and re-run.`,
    );
    if (result.stderr) console.error(`  stderr: ${result.stderr.trim().split("\n").slice(-3).join(" | ")}`);
    if (result.stdout) console.error(`  stdout: ${result.stdout.trim().split("\n").slice(-3).join(" | ")}`);
    process.exit(4);
  }
  const out = result.stdout || "";
  const tierMatch = out.match(/"tier":\s*(\d+)/);
  const planMatch = out.match(/"planKey":\s*"([^"]+)"/);
  if (!tierMatch || !planMatch) {
    console.error(
      `[disable-free-notif] FATAL: entitlement lookup for ${userId} returned unparseable output ` +
        `(tier or planKey not found). Output format may have changed; refusing to proceed.`,
    );
    console.error(`  output (last 5 lines): ${out.trim().split("\n").slice(-5).join(" | ")}`);
    process.exit(4);
  }
  tierByUserId.set(userId, parseInt(tierMatch[1], 10));
  planByUserId.set(userId, planMatch[1]);
}

// Tier breakdown (per unique user, since entitlement is per-user).
const breakdown = {};
for (const tier of tierByUserId.values()) {
  breakdown[tier] = (breakdown[tier] ?? 0) + 1;
}
console.log(`[disable-free-notif] tier breakdown (per unique user):`, breakdown);

// Build the cleanup target list from ALL rows whose userId resolves to
// tier=0. Iterating allEnabled (NOT a deduped userId set) ensures
// multi-variant free users get ALL their variants cleaned up.
const freeRows = allEnabled.filter((r) => tierByUserId.get(r.userId) === 0);
console.log(
  `\n[disable-free-notif] FREE-tier rows to disable (across all variants): ${freeRows.length}`,
);
for (const r of freeRows) {
  console.log(
    `  ${r.userId}  variant=${r.variant}  ${r.digestMode ?? "<undefined>"}/${r.sensitivity ?? "<undefined>"}  ` +
      `eventTypes=[${(r.eventTypes ?? []).length}]  channels=[${(r.channels ?? []).length}]  ` +
      `planKey=${planByUserId.get(r.userId)}`,
  );
}

if (freeRows.length === 0) {
  console.log(
    "\n[disable-free-notif] no free-tier rows in the enabled set — nothing to do.",
  );
  process.exit(0);
}

if (!APPLY) {
  console.log(
    "\n[disable-free-notif] dry-run complete. Re-run with --apply to flip enabled=false " +
      "(eventTypes + channels preserved per row).",
  );
  process.exit(0);
}

console.log("\n[disable-free-notif] applying...");
let disabled = 0;
let failed = 0;
const failures = [];

for (const row of freeRows) {
  // Pass through row.eventTypes + row.channels — setAlertRulesForUser
  // PATCHES these fields, so omitting them (or sending []) would wipe the
  // user's saved subscriptions/channels (Greptile P1 round 1). Sensitivity
  // intentionally omitted (preserved by the patch-vs-insert semantics).
  const args = JSON.stringify({
    userId: row.userId,
    variant: row.variant,
    enabled: false,
    eventTypes: row.eventTypes ?? [],
    channels: row.channels ?? [],
  });
  const result = spawnSync(
    "npx",
    ["convex", "run", "alertRules:setAlertRulesForUser", args],
    {
      env: { ...process.env, CONVEX_URL, CONVEX_DEPLOY_KEY },
      encoding: "utf-8",
      timeout: 30_000,
    },
  );
  if (result.status === 0) {
    console.log(`✓ ${row.userId} / ${row.variant}`);
    disabled++;
  } else {
    const msg = (result.stderr || result.stdout || "")
      .trim()
      .split("\n")
      .slice(-3)
      .join(" | ");
    console.error(`✗ ${row.userId} / ${row.variant}: ${msg}`);
    failed++;
    failures.push({ userId: row.userId, variant: row.variant, error: msg });
  }
}

console.log(
  `\n[disable-free-notif] done. disabled=${disabled} failed=${failed}`,
);
if (failed > 0) {
  console.log("[disable-free-notif] failures:");
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
process.exit(0);
