#!/usr/bin/env node
/**
 * Read-only audit of `alertRules` rows against the shape every writer now
 * enforces (shared/alert-rule-shape.ts): registry `variant`, bounded
 * `eventTypes` / `channels`, and at most ALERT_RULES_PER_USER_MAX rows per
 * account. Run it before deploying the bounds to see what the writers would
 * reject, and after deploying to confirm the cleanup landed.
 *
 * Why it exists (Strix pentest 2026-10-27): one account wrote 19 rows of
 * ~910 KB each and the relay's shared read of every enabled rule tripped the
 * Convex read limit for every tenant. The reads are paginated and byte-bounded
 * now, so this script can list those rows without tripping the same limit;
 * it never writes anything.
 *
 * Usage (deploy-key auth, same as the other operator scripts):
 *   CONVEX_URL=... CONVEX_DEPLOY_KEY=... node scripts/check-alert-rule-shapes.mjs
 *   node scripts/check-alert-rule-shapes.mjs --prod       # pass `--prod` through to `npx convex run`
 *   node scripts/check-alert-rule-shapes.mjs --json       # machine-readable report on stdout
 *
 * Exit codes: 0 clean, 1 violations found, 2 could not read the table.
 *
 * Cleanup is deliberately NOT automated here: delete or rewrite the listed
 * rows by hand (`npx convex run alertRules:setAlertRulesForUser` patches an
 * in-registry variant; out-of-registry rows can only be deleted from the
 * dashboard) so an operator reviews each account before touching it.
 */
import { collectConvexPages } from "./lib/convex-run-pages.mjs";

const PAGE_ITEMS = 64;

/**
 * Merges the pages of `alertRules:listShapeViolations`. The row cap comes
 * from the query itself (`rulesPerUserMax`) so this script never drifts from
 * shared/alert-rule-shape.ts.
 */
export function summarizeShapeAudit(pages) {
  const violations = pages.flatMap((p) => p.page);
  const rulesPerUserMax = pages[0]?.rulesPerUserMax ?? Infinity;
  const rowCounts = {};
  let scanned = 0;
  for (const p of pages) {
    scanned += p.scanned ?? 0;
    for (const [userId, count] of Object.entries(p.rowCounts ?? {})) {
      rowCounts[userId] = (rowCounts[userId] ?? 0) + count;
    }
  }
  const overCap = Object.entries(rowCounts)
    .filter(([, count]) => count > rulesPerUserMax)
    .map(([userId, count]) => ({ userId, rows: count }))
    .sort((a, b) => b.rows - a.rows);
  const bytesByUser = {};
  for (const v of violations) bytesByUser[v.userId] = (bytesByUser[v.userId] ?? 0) + v.approxBytes;
  return { scanned, rulesPerUserMax, violations, overCap, bytesByUser, clean: violations.length === 0 && overCap.length === 0 };
}

function formatBytes(n) {
  return n >= 1024 * 1024 ? `${(n / (1024 * 1024)).toFixed(2)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`;
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const extraArgs = argv.filter((a) => a !== "--json");
  if (!process.env.CONVEX_DEPLOY_KEY && !extraArgs.includes("--prod")) {
    console.error("[check-alert-rule-shapes] CONVEX_DEPLOY_KEY (or --prod with a logged-in convex CLI) is required for `npx convex run` on an internal query");
  }

  let pages;
  try {
    pages = collectConvexPages("alertRules:listShapeViolations", { numItems: PAGE_ITEMS }, {
      extraArgs,
      onPage: (result, index) => {
        if (!asJson) console.error(`[check-alert-rule-shapes] page ${index + 1}: scanned ${result.scanned} rows, ${result.page.length} out of shape`);
      },
    });
  } catch (err) {
    console.error(`[check-alert-rule-shapes] could not read alertRules: ${err.message}`);
    process.exit(2);
  }

  const report = summarizeShapeAudit(pages);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[check-alert-rule-shapes] scanned ${report.scanned} alertRules rows`);
    if (report.clean) {
      console.log("[check-alert-rule-shapes] every row is in shape and no account exceeds the row cap");
    } else {
      console.log(`[check-alert-rule-shapes] ${report.violations.length} row(s) out of shape:`);
      for (const v of report.violations) {
        console.log(`  ${v.id}  user=${v.userId}  variant=${JSON.stringify(v.variant)}  enabled=${v.enabled}  ${formatBytes(v.approxBytes)}  ${v.codes.join(",")}`);
      }
      if (report.overCap.length > 0) {
        console.log(`[check-alert-rule-shapes] ${report.overCap.length} account(s) above the ${report.rulesPerUserMax}-row cap:`);
        for (const u of report.overCap) console.log(`  user=${u.userId}  rows=${u.rows}`);
      }
      const heavy = Object.entries(report.bytesByUser).sort((a, b) => b[1] - a[1]).slice(0, 10);
      if (heavy.length > 0) {
        console.log("[check-alert-rule-shapes] out-of-shape bytes by account:");
        for (const [userId, bytes] of heavy) console.log(`  user=${userId}  ${formatBytes(bytes)}`);
      }
    }
  }
  process.exit(report.clean ? 0 : 1);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
