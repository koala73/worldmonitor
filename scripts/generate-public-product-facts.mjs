#!/usr/bin/env node
/**
 * Generate stable commercial product facts and catalogs.
 *
 * Source chain:
 *   convex/config/productCatalog.ts (lifecycle, plans, prices, public copy)
 *   api/mcp/registry/index.ts        (machine-readable MCP server card)
 *
 * These outputs are committed because lifecycle, prices, entitlements, and
 * catalog identities are reviewed product contracts. Extensible inventory
 * counts are emitted separately by scripts/generate-inventory-facts.mjs.
 *
 * Usage:
 *   npm run product:facts
 *   npm run product:facts:check
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_CATALOG, PUBLIC_PRODUCT_METADATA } from '../convex/config/productCatalog.ts';
import { TOOL_REGISTRY, toolAccess } from '../api/mcp/registry/index.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');
const failures = [];

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

function emit(path, content) {
  const current = existsSync(join(ROOT, path)) ? read(path) : null;
  if (current === content) return;
  if (CHECK) {
    failures.push(`${path} is stale`);
    return;
  }
  writeFileSync(join(ROOT, path), content);
  console.log(`  ✓ ${join(ROOT, path)}`);
}

function transform(path, update) {
  const current = read(path);
  emit(path, update(current));
}

function withoutKeys(value, keys) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.has(key)));
}

function billingDurationFor(period) {
  if (period === 'monthly') return 'P1M';
  if (period === 'annual') return 'P1Y';
  return null;
}

function priceText(price) {
  if (price == null) return 'Custom';
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

const generatedTiers = readJson('pro-test/src/generated/tiers.json');
const previousFacts = existsSync(join(ROOT, 'shared/product-facts.generated.json'))
  ? readJson('shared/product-facts.generated.json')
  : null;

const publicCatalogEntries = Object.entries(PRODUCT_CATALOG)
  .filter(([, entry]) => entry.publicVisible);
const publicTierGroups = [...new Set(publicCatalogEntries.map(([, entry]) => entry.tierGroup))];
const productsById = Object.fromEntries(
  publicCatalogEntries
    .filter(([, entry]) => entry.dodoProductId)
    .map(([planKey, entry]) => [
      entry.dodoProductId,
      {
        planKey,
        tierGroup: entry.tierGroup,
        billingPeriod: entry.billingPeriod,
      },
    ]),
);
const fallbackPrices = Object.fromEntries(
  publicCatalogEntries
    .filter(([, entry]) => entry.dodoProductId && entry.priceCents != null && entry.priceCents > 0)
    .map(([, entry]) => [entry.dodoProductId, entry.priceCents]),
);

const tierGroupForLocaleKey = {
  free: 'free',
  pro: 'pro',
  proBusiness: 'pro_business',
  api: 'api_starter',
  apiBusiness: 'api_business',
  enterprise: 'enterprise',
};
const tierConfig = Object.fromEntries(
  generatedTiers.map((tier) => [
    tierGroupForLocaleKey[tier.localeKey],
    withoutKeys(tier, new Set([
      'price',
      'period',
      'monthlyPrice',
      'annualPrice',
      'monthlyProductId',
      'annualProductId',
    ])),
  ]),
);

const plans = publicCatalogEntries.map(([planKey, entry]) => ({
  planKey,
  name: entry.displayName,
  tierGroup: entry.tierGroup,
  billingPeriod: entry.billingPeriod,
  billingDuration: billingDurationFor(entry.billingPeriod),
  price: entry.priceCents == null ? null : entry.priceCents / 100,
  priceCurrency: PUBLIC_PRODUCT_METADATA.currency,
  availability: PUBLIC_PRODUCT_METADATA.availability,
  url: PUBLIC_PRODUCT_METADATA.pricingUrl,
  currentForCheckout: entry.currentForCheckout,
  selfServe: entry.selfServe,
  // Carried so pricingSummary() can DERIVE its plan-limit copy from the
  // catalog. The feature strings below used to be hand-written, which meant
  // re-running this generator faithfully reproduced stale limits and the
  // freshness gate — which only diffs the generator against its own output —
  // could never see the drift.
  dashboardAiCallsPerDay: entry.features?.planLimits?.dashboardAiCallsPerDay,
  description: [
    ...entry.marketingFeatures,
    ...(entry.highlightFeatures ?? []),
  ].join(', '),
}));

const facts = {
  _generated: 'scripts/generate-public-product-facts.mjs — do not edit by hand; run `npm run product:facts`',
  product: {
    name: PUBLIC_PRODUCT_METADATA.name,
    lifecycle: PUBLIC_PRODUCT_METADATA.lifecycle,
    canonicalUrl: PUBLIC_PRODUCT_METADATA.canonicalUrl,
    pricingUrl: PUBLIC_PRODUCT_METADATA.pricingUrl,
    primaryCtaLabel: PUBLIC_PRODUCT_METADATA.primaryCtaLabel,
  },
  currency: PUBLIC_PRODUCT_METADATA.currency,
  plans,
};

const catalogBundle = {
  _generated: facts._generated,
  facts,
  products: productsById,
  tierConfig,
  publicTierGroups,
  fallbackPrices,
};

emit('shared/product-facts.generated.json', json(facts));
emit('scripts/shared/product-facts.generated.json', json(facts));
emit('shared/product-catalog.generated.json', json(catalogBundle));
emit('scripts/shared/product-catalog.generated.json', json(catalogBundle));

const edgeModule = `// AUTO-GENERATED from convex/config/productCatalog.ts.
// Do not edit manually. Run: npm run product:facts
// @ts-check

export const PUBLIC_PRODUCT_FACTS = ${JSON.stringify(facts, null, 2)};

export const PRODUCT_CATALOG = ${JSON.stringify(productsById, null, 2)};

export const TIER_CONFIG = ${JSON.stringify(tierConfig, null, 2)};

export const PUBLIC_TIER_GROUPS = ${JSON.stringify(publicTierGroups, null, 2)};

export const FALLBACK_PRICES = ${JSON.stringify(fallbackPrices, null, 2)};
`;
emit('api/_product-catalog.generated.js', edgeModule);

function offerFor(plan) {
  const offer = {
    '@type': 'Offer',
    name: plan.name,
    price: priceText(plan.price),
    priceCurrency: plan.priceCurrency,
    availability: plan.availability,
    url: plan.url,
    description: plan.description,
  };
  if (plan.billingDuration) {
    offer.priceSpecification = {
      '@type': 'UnitPriceSpecification',
      price: priceText(plan.price),
      priceCurrency: plan.priceCurrency,
      billingDuration: plan.billingDuration,
    };
  }
  return offer;
}

function rewriteApplicationJsonLd(source, includedGroups) {
  return source.replace(
    /(<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>)([\s\S]*?)(<\/script>)/g,
    (whole, open, body, close) => {
      let block;
      try {
        block = JSON.parse(body);
      } catch {
        return whole;
      }
      if (!['SoftwareApplication', 'WebApplication'].includes(block['@type'])) return whole;

      const selectedPlans = plans.filter((plan) => (
        plan.price != null && (!includedGroups || includedGroups.includes(plan.tierGroup))
      ));
      block.offers = selectedPlans.map(offerFor);
      const indented = JSON.stringify(block, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      return `${open}\n${indented}\n    ${close}`;
    },
  );
}

const applicationJsonLdGroups = new Map([
  ['index.html', ['free', 'pro']],
  ['pro-test/welcome.html', ['free', 'pro']],
  ['pro-test/index.html', null],
]);

// Every Pro locale carries lifecycle and pricing copy, so enumerate the
// directory rather than hand-listing a subset.
const proLocalePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => `pro-test/src/locales/${name}`)
  .sort();

for (const [path, groups] of applicationJsonLdGroups) {
  transform(path, (source) => rewriteApplicationJsonLd(source, groups));
}

// The server card is the machine-readable tool catalog consumed by docs-stats
// and external MCP discovery. Generate it from the same registry as the count
// so adding tools cannot leave a syntactically valid but incomplete card.
transform('public/.well-known/mcp/server-card.json', (source) => {
  const card = JSON.parse(source);
  card.tools = TOOL_REGISTRY.map((tool) => ({
    name: tool.name,
    description: tool.description,
    _meta: { 'worldmonitor/access': toolAccess(tool) },
  }));
  return json(card);
});

// Keep lifecycle cleanup here. Inventory totals in these locale files are not
// generator-owned acceptance criteria.
for (const path of proLocalePaths) {
  transform(path, (source) => {
    const locale = JSON.parse(source);
    delete locale.nav?.reserveAccess;
    delete locale.hero?.reserveEarlyAccess;
    delete locale.hero?.emailPlaceholder;
    delete locale.hero?.emailAriaLabel;
    delete locale.twoPath?.proCta;
    delete locale.finalCta?.getPro;
    delete locale.footer?.beFirstInLine;
    delete locale.form;
    delete locale.referral;
    return json(locale);
  });
}

function replacePreviousPrices(source) {
  if (!previousFacts) return source;
  const previousByPlan = new Map(previousFacts.plans.map((plan) => [plan.planKey, plan]));
  let result = source;
  for (const plan of plans) {
    const previous = previousByPlan.get(plan.planKey);
    if (previous?.price == null || plan.price == null || previous.price === plan.price) continue;
    const oldText = priceText(previous.price);
    const nextText = priceText(plan.price);
    result = result.replaceAll(`$${oldText}`, `$${nextText}`);
    // Comma-variant rewrite only when the old price actually HAD a decimal
    // point: for integer prices the "comma form" is identical to the dot
    // form, and running it after the line above re-matches the freshly
    // written replacement's prefix ("$449.99" -> "$449,99.99").
    if (oldText.includes('.')) {
      result = result.replaceAll(
        `$${oldText.replace('.', ',')}`,
        `$${nextText.replace('.', ',')}`,
      );
    }
    result = result.replaceAll(`"${oldText}"`, `"${nextText}"`);
    result = result.replaceAll(`: ${oldText}`, `: ${nextText}`);
  }
  return result;
}

for (const path of new Set([
  'public/pricing.md',
  'docs/pricing.mdx',
  'docs/zh/pricing.mdx',
  'docs/api-commerce.mdx',
  'docs/zh/api-commerce.mdx',
  'blog-site/src/content/blog/free-vs-paid-real-time-intelligence-dashboards.md',
  'blog-site/src/content/blog/worldmonitor-mcp-server-ai-agents-real-time-intelligence.md',
  'pro-test/prerender.mjs',
  'pro-test/welcome.html',
  ...proLocalePaths,
])) {
  transform(path, replacePreviousPrices);
}

function pricingSummary() {
  const byKey = Object.fromEntries(plans.map((plan) => [plan.planKey, plan]));
  /** Catalog-derived dashboard-AI copy. `null` in the catalog means unlimited. */
  const dashboardAi = (planKey) => {
    const limit = byKey[planKey]?.dashboardAiCallsPerDay;
    if (limit === null) return 'unlimited dashboard-AI requests';
    if (typeof limit !== 'number') {
      throw new Error(`${planKey} is missing planLimits.dashboardAiCallsPerDay`);
    }
    return `${limit.toLocaleString('en-US')} dashboard-AI requests/day`;
  };
  return {
    product: PUBLIC_PRODUCT_METADATA.name,
    lifecycle: PUBLIC_PRODUCT_METADATA.lifecycle,
    url: PUBLIC_PRODUCT_METADATA.canonicalUrl,
    pricing_url: PUBLIC_PRODUCT_METADATA.pricingUrl,
    currency: PUBLIC_PRODUCT_METADATA.currency,
    plans: [
      {
        name: 'Free',
        price_usd_monthly: 0,
        signup_required: false,
        features: ['global map coverage (Resilience is Pro)', 'curated feeds', 'country briefs', 'chokepoints', 'instability scores', 'watchlists', '3 dashboard tabs'],
      },
      {
        name: 'Pro',
        price_usd_monthly: byKey.pro_monthly.price,
        price_usd_yearly: byKey.pro_annual.price,
        features: ['WM Analyst', 'Scenario Engine', 'Route Explorer', 'AI digest', 'custom widget builder', dashboardAi('pro_monthly'), 'MCP', '10 custom dashboards', 'personal license'],
      },
      {
        name: 'Pro Business',
        price_usd_monthly: byKey.pro_business_monthly.price,
        price_usd_yearly: byKey.pro_business_annual.price,
        features: ['Everything in Pro', 'commercial license', 'data export — CSV, JSON & PDF reports', '25 custom dashboards', dashboardAi('pro_business_monthly'), '250 MCP calls/day', 'priority support'],
      },
      {
        name: 'API',
        price_usd_monthly: byKey.api_starter.price,
        price_usd_yearly: byKey.api_starter_annual.price,
        features: ['REST API', 'license / API key included', '1,000 requests/day starter limit', dashboardAi('api_starter'), 'webhooks', 'structured JSON', 'OpenAPI docs', 'commercial license — for your organization'],
      },
      {
        name: 'API Business',
        price_usd_monthly: byKey.api_business.price,
        price_usd_yearly: byKey.api_business_annual.price,
        features: ['Everything in API Starter', '300 requests/minute', '10,000 requests/day', dashboardAi('api_business'), '5 Pro licenses included', 'same company email required', 'commercial license — for your customers', 'priority support'],
      },
      {
        name: 'Enterprise',
        price: 'Custom',
        contact: 'enterprise@worldmonitor.app',
        features: ['SSO/MFA/RBAC', 'team workspaces', 'white-label', 'on-premises', 'air-gapped', 'dedicated support'],
      },
    ],
  };
}

transform('public/pricing.md', (source) => {
  const generatedNote = '<!-- Product lifecycle, prices, and capability counts are generated by `npm run product:facts`. -->';
  let next = source.replace(/^Last updated:.*\n\n/m, '');
  if (!next.includes(generatedNote)) {
    next = next.replace('# Pricing - World Monitor\n', `# Pricing - World Monitor\n\n${generatedNote}\n`);
  }
  return next.replace(
    /```json\n[\s\S]*?```/,
    `\`\`\`json\n${JSON.stringify(pricingSummary(), null, 2)}\n\`\`\``,
  );
});

transform('docs/docs.json', (source) => {
  const config = JSON.parse(source);
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (value.href === 'https://www.worldmonitor.app/pro#waitlist') {
      value.href = PUBLIC_PRODUCT_METADATA.pricingUrl;
      if (value.label === 'Get Early Access') value.label = PUBLIC_PRODUCT_METADATA.primaryCtaLabel;
      if (value.label === '获取早期访问权限') value.label = '查看 Pro 方案';
    }
    Object.values(value).forEach(visit);
  };
  visit(config);
  return json(config);
});

if (CHECK && failures.length > 0) {
  console.error(`public product facts check FAILED (${failures.length}):`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error('\nRun `npm run product:facts` and commit the generated changes.');
  process.exit(1);
}

if (CHECK) {
  console.log('public product facts check OK');
}
