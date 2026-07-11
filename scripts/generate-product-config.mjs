#!/usr/bin/env node
/**
 * Generate product configuration files from the canonical catalog.
 *
 * Reads: convex/config/productCatalog.ts
 * Writes:
 *   - src/config/products.generated.ts   (product IDs for dashboard)
 *   - src/config/product-ids.generated.ts (analytics-safe product ID allowlist)
 *   - pro-test/src/generated/tiers.json  (tier view model for /pro page)
 *   - pro-test/src/locales/*.json       (English pricing feature placeholders)
 *
 * Usage: npx tsx scripts/generate-product-config.mjs
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const planLimitEntries = Object.entries(PRODUCT_CATALOG)
  .map(([key, e]) => `  ${JSON.stringify(key)}: ${JSON.stringify(e.features.planLimits ?? null)},`)
  .join('\n');

const productsTs = `// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npx tsx scripts/generate-product-config.mjs

export const DODO_PRODUCTS = {
${productEntries}
} as const;

export const PLAN_LIMITS = {
${planLimitEntries}
} as const;

/** Default product for upgrade CTAs (Pro Monthly). */
export const DEFAULT_UPGRADE_PRODUCT = DODO_PRODUCTS.PRO_MONTHLY;
`;

const productsPath = join(ROOT, 'src/config/products.generated.ts');
writeFileSync(productsPath, productsTs);
console.log(`  ✓ ${productsPath}`);

const productIdsTs = `// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npx tsx scripts/generate-product-config.mjs

/** Product IDs accepted by client-side analytics without loading checkout config. */
export const DODO_PRODUCT_IDS: ReadonlySet<string> = new Set([
${Object.values(PRODUCT_CATALOG)
  .filter((entry) => entry.dodoProductId)
  .map((entry) => `  '${entry.dodoProductId}',`)
  .join('\n')}
]);
`;

const productIdsPath = join(ROOT, 'src/config/product-ids.generated.ts');
writeFileSync(productIdsPath, productIdsTs);
console.log(`  ✓ ${productIdsPath}`);

// ---------------------------------------------------------------------------
// 1b. Generate api/_product-fallback-prices.js
// ---------------------------------------------------------------------------

const fallbackEntries = Object.entries(PRODUCT_CATALOG)
  .filter(([, e]) => e.dodoProductId && e.priceCents != null && e.priceCents > 0)
  .map(([, e]) => `  '${e.dodoProductId}': ${e.priceCents},  // ${e.displayName}`)
  .join('\n');

const fallbackJs = `// AUTO-GENERATED from convex/config/productCatalog.ts
// Do not edit manually. Run: npx tsx scripts/generate-product-config.mjs
// @ts-check

/** Fallback prices (cents) when Dodo API is unreachable for individual products. */
export const FALLBACK_PRICES = {
${fallbackEntries}
};
`;

const fallbackPath = join(ROOT, 'api/_product-fallback-prices.js');
writeFileSync(fallbackPath, fallbackJs);
console.log(`  ✓ ${fallbackPath}`);

// ---------------------------------------------------------------------------
// 2. Generate pro-test/src/generated/tiers.json
// ---------------------------------------------------------------------------

// Group catalog entries by tierGroup, merge monthly/annual into Tier view model
const tiersPath = join(ROOT, 'pro-test/src/generated/tiers.json');
const previousGeneratedFeaturesByKey = readGeneratedTierFeatureSnapshot(tiersPath);

const tierGroups = new Map();
for (const entry of Object.values(PRODUCT_CATALOG)) {
  if (!entry.publicVisible) continue;
  if (!tierGroups.has(entry.tierGroup)) {
    tierGroups.set(entry.tierGroup, []);
  }
  tierGroups.get(entry.tierGroup).push(entry);
}

const tiers = [];
const localeFeaturesByKey = {};
for (const [tierGroup, entries] of tierGroups) {
  const monthly = entries.find((e) => e.billingPeriod === 'monthly');
  const annual = entries.find((e) => e.billingPeriod === 'annual');
  const primary = monthly || entries[0];

  // Use marketing features from the monthly variant (or first entry)
  const marketingFeatures =
    primary.marketingFeatures.length > 0
      ? primary.marketingFeatures
      : (annual?.marketingFeatures?.length > 0 ? annual.marketingFeatures : []);

  const localeKey = getTierLocaleKey(tierGroup);
  const tier = { name: getTierDisplayName(primary.tierGroup), localeKey };

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
  tier.planLimits = primary.features.planLimits ?? null;
  if (localeFeaturesByKey[localeKey]) {
    throw new Error(`[product-config] Duplicate pro locale tier key "${localeKey}" generated for public tier group "${tierGroup}".`);
  }
  localeFeaturesByKey[localeKey] = marketingFeatures;

  if (primary.selfServe && primary.dodoProductId) {
    tier.monthlyProductId = primary.dodoProductId;
    if (annual?.dodoProductId) {
      tier.annualProductId = annual.dodoProductId;
    }
  } else if (!primary.selfServe && primary.priceCents === 0) {
    tier.cta = 'Get Started';
    tier.href = 'https://worldmonitor.app/dashboard';
  } else if (!primary.selfServe && primary.priceCents === null) {
    tier.cta = 'Contact Sales';
    tier.href = 'mailto:enterprise@worldmonitor.app';
  }

  tier.highlighted = primary.highlighted;

  tiers.push(tier);
}

writeFileSync(tiersPath, JSON.stringify(tiers, null, 2) + '\n');
console.log(`  ✓ ${tiersPath}`);

const syncedLocaleCount = syncLocalePricingFeaturePlaceholders(join(ROOT, 'pro-test/src/locales'), localeFeaturesByKey, previousGeneratedFeaturesByKey);
if (syncedLocaleCount > 0) {
  console.log(`  ✓ refreshed pricing features in ${syncedLocaleCount} pro locale file(s)`);
}

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

function getTierLocaleKey(tierGroup) {
  const keys = {
    free: 'free',
    pro: 'pro',
    api_starter: 'api',
    api_business: 'apiBusiness',
    enterprise: 'enterprise',
  };
  const key = keys[tierGroup];
  if (!key) {
    throw new Error(`[product-config] Missing pro locale tier key mapping for public tier group "${tierGroup}".`);
  }
  return key;
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

function syncLocalePricingFeaturePlaceholders(localesDir, generatedFeaturesByKey, previousGeneratedFeaturesByKey) {
  if (!existsSync(localesDir)) return 0;

  const englishPath = join(localesDir, 'en.json');
  if (!existsSync(englishPath)) {
    throw new Error(`[product-config] Missing English pro locale file: ${englishPath}`);
  }

  const previousEnglishFeatures = pricingFeatureSnapshot(readJsonFile(englishPath));
  const missingEnglishKeys = Object.keys(generatedFeaturesByKey)
    .filter((key) => !Array.isArray(previousEnglishFeatures[key]));
  if (missingEnglishKeys.length > 0) {
    throw new Error(
      `[product-config] Missing English pro locale pricing feature placeholder(s): ${missingEnglishKeys.join(', ')}. ` +
        'Verify getTierLocaleKey() matches pro-test/src/locales/en.json pricing.tiers keys.',
    );
  }

  let changedFiles = 0;
  const preservedTranslations = [];
  for (const file of readdirSync(localesDir).filter((name) => name.endsWith('.json')).sort()) {
    const localePath = join(localesDir, file);
    const locale = readJsonFile(localePath);
    const pricingTiers = locale?.pricing?.tiers;
    if (!pricingTiers || typeof pricingTiers !== 'object' || Array.isArray(pricingTiers)) continue;

    let changed = false;
    for (const [key, generatedFeatures] of Object.entries(generatedFeaturesByKey)) {
      const tier = pricingTiers[key];
      if (!tier || typeof tier !== 'object' || Array.isArray(tier)) continue;

      const currentFeatures = tier.features;
      if (!Array.isArray(currentFeatures)) continue;

      const previousGeneratedFeatures = previousGeneratedFeaturesByKey[key] || previousEnglishFeatures[key];
      const generatedFeaturesChanged = !sameStringArray(previousGeneratedFeatures, generatedFeatures);
      const isEnglishSource = file === 'en.json';
      const isGeneratedPlaceholder = sameStringArray(currentFeatures, previousGeneratedFeatures);
      if ((isEnglishSource || isGeneratedPlaceholder) && !sameStringArray(currentFeatures, generatedFeatures)) {
        tier.features = generatedFeatures;
        changed = true;
      } else if (!isEnglishSource && generatedFeaturesChanged && !sameStringArray(currentFeatures, generatedFeatures)) {
        preservedTranslations.push(`${file}:pricing.tiers.${key}.features`);
      }
    }

    if (changed) {
      writeFileSync(localePath, JSON.stringify(locale, null, 2) + '\n');
      changedFiles += 1;
      console.log(`  ✓ ${localePath}`);
    }
  }

  if (preservedTranslations.length > 0) {
    console.warn(
      `  ! preserved translated pricing features after catalog changes (${preservedTranslations.length}): ` +
        preservedTranslations.join(', '),
    );
  }

  return changedFiles;
}

function readGeneratedTierFeatureSnapshot(path) {
  if (!existsSync(path)) return {};

  const generatedTiers = readJsonFile(path);
  if (!Array.isArray(generatedTiers)) return {};

  const featuresByKey = {};
  for (const tier of generatedTiers) {
    if (!tier || typeof tier !== 'object' || Array.isArray(tier) || !Array.isArray(tier.features)) continue;

    const key = typeof tier.localeKey === 'string' ? tier.localeKey : getLegacyTierLocaleKey(tier.name);
    if (key) {
      featuresByKey[key] = tier.features;
    }
  }

  return featuresByKey;
}

function getLegacyTierLocaleKey(tierName) {
  const keys = {
    Free: 'free',
    Pro: 'pro',
    API: 'api',
    Enterprise: 'enterprise',
  };
  return typeof tierName === 'string' ? keys[tierName] : undefined;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function pricingFeatureSnapshot(locale) {
  const tiers = locale?.pricing?.tiers;
  if (!tiers || typeof tiers !== 'object' || Array.isArray(tiers)) return {};

  return Object.fromEntries(
    Object.entries(tiers)
      .filter(([, tier]) => tier && typeof tier === 'object' && !Array.isArray(tier) && Array.isArray(tier.features))
      .map(([key, tier]) => [key, tier.features]),
  );
}

function sameStringArray(left, right) {
  return Array.isArray(left) &&
    Array.isArray(right) &&
    left.length === right.length &&
    left.every((value, index) => value === right[index]);
}
