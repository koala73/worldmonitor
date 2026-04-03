#!/usr/bin/env node
/**
 * Generate product configuration files from the canonical catalog.
 *
 * Reads: convex/config/productCatalog.ts
 * Writes:
 *   - src/config/products.generated.ts   (product IDs for dashboard)
 *   - pro-test/src/generated/tiers.json  (tier view model for /pro page)
 *
 * Usage: npx tsx scripts/generate-product-config.mjs
 */

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Dynamic import so tsx handles the TS transpilation
const { PRODUCT_CATALOG } = await import('../convex/config/productCatalog.ts');

// ---------------------------------------------------------------------------
// 1. Generate src/config/products.generated.ts
// ---------------------------------------------------------------------------

// Build the DODO_PRODUCTS export preserving existing key naming convention:
// PRO_MONTHLY, PRO_ANNUAL, API_STARTER_MONTHLY, API_STARTER_ANNUAL, API_BUSINESS, ENTERPRISE
const KEY_MAP = {
  pro_monthly: 'PRO_MONTHLY',
  pro_annual: 'PRO_ANNUAL',
  api_starter: 'API_STARTER_MONTHLY',
  api_starter_annual: 'API_STARTER_ANNUAL',
  api_business: 'API_BUSINESS',
  enterprise: 'ENTERPRISE',
};

const productEntries = Object.entries(PRODUCT_CATALOG)
  .filter(([, e]) => e.dodoProductId)
  .map(([key, e]) => {
    const exportKey = KEY_MAP[key] || key.toUpperCase();
    return `  ${exportKey}: '${e.dodoProductId}',`;
  })
  .join('\n');

const productsTs = `// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npx tsx scripts/generate-product-config.mjs

export const DODO_PRODUCTS = {
${productEntries}
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
`;

const productsPath = join(ROOT, 'src/config/products.generated.ts');
writeFileSync(productsPath, productsTs);
console.log(`  ✓ ${productsPath}`);

// ---------------------------------------------------------------------------
// 2. Generate pro-test/src/generated/tiers.json
// ---------------------------------------------------------------------------

// Group catalog entries by tierGroup, merge monthly/annual into Tier view model
const tierGroups = new Map();
for (const entry of Object.values(PRODUCT_CATALOG)) {
  if (!entry.publicVisible) continue;
  if (!tierGroups.has(entry.tierGroup)) {
    tierGroups.set(entry.tierGroup, []);
  }
  tierGroups.get(entry.tierGroup).push(entry);
}

const tiers = [];
for (const [, entries] of tierGroups) {
  const monthly = entries.find((e) => e.billingPeriod === 'monthly');
  const annual = entries.find((e) => e.billingPeriod === 'annual');
  const primary = monthly || entries[0];

  // Use marketing features from the monthly variant (or first entry)
  const marketingFeatures =
    primary.marketingFeatures.length > 0
      ? primary.marketingFeatures
      : (annual?.marketingFeatures?.length > 0 ? annual.marketingFeatures : []);

  const tier = { name: getTierDisplayName(primary.tierGroup) };

  if (primary.priceCents === 0) {
    // Free tier
    tier.price = 0;
    tier.period = 'forever';
  } else if (primary.priceCents === null) {
    // Custom/contact tier
    tier.price = null;
  } else {
    // Paid tier with monthly price
    tier.monthlyPrice = primary.priceCents / 100;
  }

  if (annual && annual.priceCents != null) {
    tier.annualPrice = annual.priceCents / 100;
  }

  tier.description = getDescription(primary.tierGroup);
  tier.features = marketingFeatures;

  if (primary.selfServe && primary.dodoProductId) {
    tier.monthlyProductId = primary.dodoProductId;
    if (annual?.dodoProductId) {
      tier.annualProductId = annual.dodoProductId;
    }
  } else if (!primary.selfServe && primary.priceCents === 0) {
    tier.cta = 'Get Started';
    tier.href = 'https://worldmonitor.app';
  } else if (!primary.selfServe && primary.priceCents === null) {
    tier.cta = 'Contact Sales';
    tier.href = 'mailto:enterprise@worldmonitor.app';
  }

  tier.highlighted = primary.highlighted;

  tiers.push(tier);
}

const tiersPath = join(ROOT, 'pro-test/src/generated/tiers.json');
writeFileSync(tiersPath, JSON.stringify(tiers, null, 2) + '\n');
console.log(`  ✓ ${tiersPath}`);

console.log('\nDone. Remember to rebuild /pro: cd pro-test && npm run build');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTierDisplayName(tierGroup) {
  const names = {
    free: 'Free',
    pro: 'Pro',
    api_starter: 'API',
    api_business: 'API Business',
    enterprise: 'Enterprise',
  };
  return names[tierGroup] || tierGroup;
}

function getDescription(tierGroup) {
  const descriptions = {
    free: 'Get started with the essentials',
    pro: 'Full intelligence dashboard',
    api_starter: 'Programmatic access to intelligence data',
    api_business: 'High-volume API for teams',
    enterprise: 'Custom solutions for organizations',
  };
  return descriptions[tierGroup] || '';
}
