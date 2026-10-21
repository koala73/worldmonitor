#!/usr/bin/env node
/**
 * audit-dodo-catalog — detect drift between Dodo Payments products and
 * our local catalog (`convex/config/productCatalog.ts`).
 *
 * Why this exists
 *
 *   When operators edit a product in the Dodo dashboard (rename, reprice,
 *   change billing term), Dodo mints a NEW product_id. Our catalog and
 *   `LEGACY_PRODUCT_ALIASES` are static — they don't auto-sync. The first
 *   subscription.* webhook for a customer on the new product hits
 *   `resolvePlanKey` with an unmapped ID. Before this script, the result
 *   was a 500 webhook → Dodo retries forever → customer's entitlement
 *   wedged. After: `resolvePlanKey` falls open with a fallback + Sentry
 *   alert (subscriptionHelpers.ts), AND this script catches the drift
 *   PROACTIVELY before any webhook arrives.
 *
 * What it does
 *
 *   1. Reads convex/config/productCatalog.ts to extract every dodoProductId
 *      from PRODUCT_CATALOG entries AND from LEGACY_PRODUCT_ALIASES.
 *   2. Calls Dodo Payments API `client.products.list()` to enumerate every
 *      product in the active business account.
 *   3. Diffs the two sets:
 *        NEW:    product_id in Dodo, NOT in catalog → would crash a webhook
 *        STALE:  dodoProductId in catalog, NOT in Dodo → safe but cluttered
 *   4. Prints a structured report. Exits 1 if any NEW products are found
 *      (the dangerous direction); exits 0 with a warning if only STALE.
 *
 * How to run
 *
 *   DODO_API_KEY=sk_live_... node scripts/audit-dodo-catalog.cjs
 *   DODO_API_KEY=sk_live_... node scripts/audit-dodo-catalog.cjs --json
 *
 *   For each NEW product, the report includes the product name +
 *   recurring flag, with a heuristic suggestion of which planKey to use
 *   (matching against catalog displayName / planKey). Operator copies the
 *   suggested entry into LEGACY_PRODUCT_ALIASES (or PRODUCT_CATALOG) and
 *   re-runs seedProductPlans.
 *
 *   Wired as `npm run audit:dodo-catalog`. NOT included in PR-gate
 *   typecheck because it requires DODO_API_KEY and a live network call —
 *   intended for nightly CI / on-demand operator use, not per-PR.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(REPO_ROOT, 'convex/config/productCatalog.ts');

const args = new Set(process.argv.slice(2));
const JSON_OUTPUT = args.has('--json');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

// ---------------------------------------------------------------------------
// Local catalog: extract every known dodoProductId from productCatalog.ts.
// ---------------------------------------------------------------------------

/**
 * Walk a TypeScript object literal at the given start offset and extract
 * each direct-child `{ ... }` entry block as a substring. Tracks brace
 * depth char-by-char so an entry that contains a nested object literal
 * (e.g., a metadata blob) is captured intact.
 *
 * Order-independent: each returned block is the full text of one catalog
 * entry. Caller can run independent per-block regexes for the two fields,
 * which means `dodoProductId` and `planKey` can appear in either order
 * without affecting the audit (P1 review on PR #3642).
 */
function extractEntryBlocks(src, recordStart) {
  // Find the `{` that opens the Record<...> object literal.
  const openIdx = src.indexOf('{', recordStart);
  if (openIdx === -1) return [];
  const blocks = [];
  let depth = 1; // one '{' already consumed
  let entryStart = -1;
  for (let i = openIdx + 1; i < src.length; i++) {
    const c = src[i];
    if (c === '{') {
      if (depth === 1) entryStart = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) break; // exited the Record itself
      if (depth === 1 && entryStart !== -1) {
        blocks.push(src.slice(entryStart, i + 1));
        entryStart = -1;
      }
    }
  }
  return blocks;
}

function loadCatalogProductIds() {
  if (!fs.existsSync(CATALOG_PATH)) {
    fail(`[audit-dodo-catalog] Catalog file not found: ${CATALOG_PATH}`);
  }
  const src = fs.readFileSync(CATALOG_PATH, 'utf8');

  /** dodoProductId → planKey, with origin (catalog vs legacy_alias) for the report. */
  const byId = new Map();

  // PRODUCT_CATALOG: walk the Record literal, extract each entry block,
  // then independently grep for `dodoProductId` and `planKey` inside it.
  // The two-pass approach is order-independent — TypeScript object literals
  // don't constrain key order, so an operator adding `planKey` before
  // `dodoProductId` in a new entry would have silently been missed by the
  // previous one-pass regex.
  const catalogStart = src.search(/PRODUCT_CATALOG\b[^=]*=\s*\{/);
  if (catalogStart !== -1) {
    for (const block of extractEntryBlocks(src, catalogStart)) {
      const idMatch = block.match(/\bdodoProductId\s*:\s*["']([^"']+)["']/);
      const keyMatch = block.match(/\bplanKey\s*:\s*["']([^"']+)["']/);
      if (idMatch && keyMatch) {
        byId.set(idMatch[1], { planKey: keyMatch[1], origin: 'PRODUCT_CATALOG' });
      }
    }
  }

  // LEGACY_PRODUCT_ALIASES entries: `"pdt_...": "planKey"`
  // Constrained to the LEGACY_PRODUCT_ALIASES block to avoid matching unrelated
  // string maps elsewhere in the file.
  const aliasesBlockMatch = src.match(/LEGACY_PRODUCT_ALIASES[^=]*=\s*\{([\s\S]*?)\}\s*;/);
  if (aliasesBlockMatch) {
    const aliasesBlock = aliasesBlockMatch[1];
    const aliasRe = /["']([^"']+)["']\s*:\s*["']([^"']+)["']/g;
    let m;
    while ((m = aliasRe.exec(aliasesBlock)) !== null) {
      // Only treat as a Dodo product ID if it looks like one (`pdt_` prefix).
      if (m[1].startsWith('pdt_') && !byId.has(m[1])) {
        byId.set(m[1], { planKey: m[2], origin: 'LEGACY_PRODUCT_ALIASES' });
      }
    }
  }

  return byId;
}

// ---------------------------------------------------------------------------
// Heuristic: given a Dodo product (name + price + interval), suggest the
// closest planKey in our catalog by display-name fuzzy match.
//
// The hardcoded `tokens` list mirrors the planKey set in
// convex/config/productCatalog.ts. If new planKeys are added, extend this
// list to keep the suggestion accurate.
// ---------------------------------------------------------------------------
function suggestPlanKey(dodoProduct) {
  const name = (dodoProduct.name || '').toLowerCase();
  // Keep these in lockstep with PRODUCT_CATALOG planKeys in productCatalog.ts.
  // Order matters — first-match-wins. List most-specific multi-token
  // entries before less-specific ones. (P2 review on PR #3642: "Pro
  // Monthly Annual" would match `['pro', 'annual']` before
  // `['pro', 'monthly']` if the latter weren't listed first. Theoretical
  // — Dodo wouldn't actually name a product like that — but the ordering
  // should still reflect longest-specific-match semantics.)
  const tokens = [
    { keys: ['enterprise'], planKey: 'enterprise' },
    { keys: ['api', 'business'], planKey: 'api_business' },
    { keys: ['api', 'starter', 'annual'], planKey: 'api_starter_annual' },
    { keys: ['api', 'starter'], planKey: 'api_starter' },
    { keys: ['pro', 'monthly'], planKey: 'pro_monthly' }, // ← before 'pro+annual' (P2 fix)
    { keys: ['pro', 'annual'], planKey: 'pro_annual' },
    { keys: ['pro'], planKey: 'pro_monthly' },
  ];
  for (const t of tokens) {
    if (t.keys.every((k) => name.includes(k))) return t.planKey;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dodo API call.
// ---------------------------------------------------------------------------

const DODO_API_TIMEOUT_MS = 30_000;

async function listDodoProducts(apiKey) {
  // Lazy require — keeps the script importable from contexts that don't
  // have @dodopayments installed (e.g. minimal CI containers running other
  // checks). Failing gracefully here is preferable to a hard crash.
  let DodoPayments;
  try {
    ({ DodoPayments } = require('dodopayments'));
  } catch (err) {
    fail(`[audit-dodo-catalog] dodopayments npm package not found. Run \`npm install\` and retry.\n  ${err.message}`);
  }
  const client = new DodoPayments({ bearerToken: apiKey });

  // 30s wall-clock cap on the entire enumeration. The SDK's `for await`
  // iterator paginates internally — without a timeout, a network partition
  // / slow-loris proxy / Dodo API outage would hang the script forever
  // (P2 review on PR #3642). Race against a timer; on timeout, throw with
  // a clear message so the operator knows it wasn't a parser issue.
  const enumerate = async () => {
    const products = [];
    for await (const product of client.products.list()) {
      products.push(product);
    }
    return products;
  };
  return Promise.race([
    enumerate(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(
          `Dodo API enumeration exceeded ${DODO_API_TIMEOUT_MS}ms — ` +
          `check Dodo status (status.dodopayments.com) or network connectivity.`,
        )),
        DODO_API_TIMEOUT_MS,
      ),
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const apiKey = process.env.DODO_API_KEY;
  if (!apiKey) {
    fail(
      '[audit-dodo-catalog] DODO_API_KEY env var not set.\n' +
        'Run: DODO_API_KEY=sk_live_... node scripts/audit-dodo-catalog.cjs',
    );
  }

  const localById = loadCatalogProductIds();
  const dodoProducts = await listDodoProducts(apiKey);
  const dodoById = new Map(dodoProducts.map((p) => [p.product_id, p]));

  /** Products in Dodo but NOT in our catalog — would crash a webhook on next sub event. */
  const newProducts = [];
  for (const [id, product] of dodoById) {
    if (!localById.has(id)) newProducts.push(product);
  }

  /** Product IDs in our catalog but NOT in Dodo — clutter, mostly harmless. */
  const stale = [];
  for (const [id, info] of localById) {
    if (!dodoById.has(id)) stale.push({ id, ...info });
  }

  if (JSON_OUTPUT) {
    console.log(JSON.stringify({
      newProducts: newProducts.map((p) => ({
        product_id: p.product_id,
        name: p.name,
        is_recurring: p.is_recurring,
        price: p.price,
        currency: p.currency,
        suggestedPlanKey: suggestPlanKey(p),
      })),
      stale,
      summary: {
        dodoTotal: dodoProducts.length,
        localTotal: localById.size,
        newCount: newProducts.length,
        staleCount: stale.length,
      },
    }, null, 2));
  } else {
    console.log(`[audit-dodo-catalog] Dodo: ${dodoProducts.length} products | local catalog: ${localById.size} mappings`);
    if (newProducts.length === 0 && stale.length === 0) {
      console.log('[audit-dodo-catalog] PASS — no drift.');
    }
    if (newProducts.length > 0) {
      console.error(`\n[audit-dodo-catalog] NEW (in Dodo, NOT in catalog) — ${newProducts.length}:`);
      for (const p of newProducts) {
        const suggestion = suggestPlanKey(p);
        console.error(`  ${p.product_id}  ${p.name ?? '(no name)'}${p.is_recurring ? '  [recurring]' : ''}`);
        if (suggestion) {
          console.error(`    suggested LEGACY_PRODUCT_ALIASES entry:  "${p.product_id}": "${suggestion}",`);
        } else {
          console.error(`    no automatic match — review manually and add to PRODUCT_CATALOG`);
        }
      }
      console.error(
        '\n  Each NEW product would crash the next subscription.* webhook for any customer ' +
        'on it (resolvePlanKey would fall through to the FALLBACK_PLAN_KEY in subscriptionHelpers.ts ' +
        'and capture an alert). Add the suggested entry to convex/config/productCatalog.ts ' +
        'LEGACY_PRODUCT_ALIASES (or a new PRODUCT_CATALOG entry), then re-run seedProductPlans.',
      );
    }
    if (stale.length > 0) {
      console.warn(`\n[audit-dodo-catalog] STALE (in catalog, NOT in Dodo) — ${stale.length}:`);
      for (const s of stale) {
        console.warn(`  ${s.id}  → ${s.planKey}  [${s.origin}]`);
      }
      console.warn(
        '\n  STALE entries are safe (they just never resolve), but pruning keeps the catalog ' +
        'honest. Likely candidates: products you deleted in Dodo dashboard.',
      );
    }
  }

  process.exit(newProducts.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('[audit-dodo-catalog] FAILED:', err);
  process.exit(2);
});
