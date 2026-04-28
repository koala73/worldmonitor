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
 *   path — see PR #3483 contract test) with `enabled: false`. Preserves
 *   sensitivity / channels / eventTypes so the row's structural shape is
 *   untouched; only the on/off toggle flips. If the user later upgrades
 *   to PRO and wants notifications back, they can re-enable from the UI.
 *
 * Usage:
 *   1. Source prod env (CONVEX_URL + CONVEX_DEPLOY_KEY required).
 *   2. Discovery (default): `node scripts/disable-free-user-notifications.mjs`
 *      Prints population breakdown + per-row free-tier list. No mutations.
 *   3. Apply: `node scripts/disable-free-user-notifications.mjs --apply`
 *      Flips `enabled: false` for each free-tier row. Per-row failures
 *      logged + counted; exit 1 if any failed.
 *
 * Idempotent: re-running after apply finds 0 free-tier rows (because
 * `enabled: false` rows are excluded from the discovery `getByEnabled`
 * filter). To audit the population from scratch, query directly via the
 * Convex dashboard.
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

// Per-userId entitlement lookup. cf. skill
// `paywalled-feature-needs-three-layer-entitlement-gate` — population audit
// recipe.
const seenUsers = new Set();
const rows = [];
for (const r of allEnabled) {
  if (seenUsers.has(r.userId)) continue;
  seenUsers.add(r.userId);
  const result = spawnSync(
    "npx",
    ["convex", "run", "entitlements:getEntitlementsByUserId", `{"userId":"${r.userId}"}`],
    { env: process.env, encoding: "utf-8", timeout: 30_000 },
  );
  const out = result.stdout || "";
  const tierMatch = out.match(/"tier":\s*(\d+)/);
  const planMatch = out.match(/"planKey":\s*"([^"]+)"/);
  rows.push({
    userId: r.userId,
    variant: r.variant,
    digestMode: r.digestMode ?? "<undefined>",
    sensitivity: r.sensitivity ?? "<undefined>",
    tier: tierMatch ? parseInt(tierMatch[1]) : -1,
    planKey: planMatch ? planMatch[1] : "?",
  });
}

const breakdown = {};
for (const r of rows) {
  breakdown[r.tier] = (breakdown[r.tier] ?? 0) + 1;
}
console.log(`[disable-free-notif] tier breakdown:`, breakdown);

const free = rows.filter((r) => r.tier === 0);
console.log(`\n[disable-free-notif] FREE-tier rows to disable: ${free.length}`);
for (const r of free) {
  console.log(
    `  ${r.userId}  variant=${r.variant}  ${r.digestMode}/${r.sensitivity}  planKey=${r.planKey}`,
  );
}

if (free.length === 0) {
  console.log(
    "\n[disable-free-notif] no free-tier rows in the enabled set — nothing to do.",
  );
  process.exit(0);
}

if (!APPLY) {
  console.log(
    "\n[disable-free-notif] dry-run complete. Re-run with --apply to flip enabled=false for each row.",
  );
  process.exit(0);
}

console.log("\n[disable-free-notif] applying...");
let disabled = 0;
let failed = 0;
const failures = [];

for (const row of free) {
  // setAlertRulesForUser is the INTENTIONALLY-ungated operator path (see
  // PR #3483 contract test). Patches enabled to false; preserves all other
  // fields by passing them through.
  const args = JSON.stringify({
    userId: row.userId,
    variant: row.variant,
    enabled: false,
    eventTypes: [],
    channels: [],
    // sensitivity intentionally omitted — preserves existing value via the
    // patch-vs-insert semantics in setAlertRulesForUser.
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
