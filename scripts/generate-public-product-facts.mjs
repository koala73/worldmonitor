#!/usr/bin/env node
/**
 * Generate public product facts and synchronize current acquisition surfaces.
 *
 * Source chain:
 *   convex/config/productCatalog.ts (lifecycle, plans, prices, public copy)
 *   api/mcp/registry/index.ts        (live MCP tool registry)
 *   scripts/docs-stats.mjs           (repository-derived stable counts)
 *
 * Outputs are committed so Edge, Railway, static Markdown/JSON, structured
 * data, the Pro bundle, and agent-discovery clients all publish the same facts.
 *
 * Usage:
 *   npm run product:facts
 *   npm run product:facts:check
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCT_CATALOG, PUBLIC_PRODUCT_METADATA } from '../convex/config/productCatalog.ts';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { computeStats } from './docs-stats.mjs';

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

function replaceMcpToolCounts(source, count) {
  return source
    .replace(/\b\d+(?=-tool MCP server\b)/g, String(count))
    .replace(/\b\d+(?=\s+MCP tools\b)/g, String(count))
    .replace(/\b\d+(?=\s+(?:live\s+)?(?:geopolitical intelligence\s+)?tools\b)/g, String(count))
    .replace(/\b\d+\+(?=\s+(?:MCP\s+)?tools\b)/g, String(count))
    .replace(/\b\d+(?=\s+\[MCP tools\])/g, String(count))
    .replace(/\b\d+(?=\s+tool definitions\b)/g, String(count))
    // docs/mcp-quickstart.mdx phrasing — pinned by scripts/docs-stats.mjs
    // (`receives (\d+) compressed tool descriptions`), so it must be rewritten
    // here or every count bump reds the docs check.
    .replace(/\b\d+(?=\s+compressed tool descriptions\b)/g, String(count))
    .replace(/\b\d+(?=\s*个\s*(?:MCP\s*)?(?:实时|压缩的)?工具)/g, String(count));
}

function rewriteStrings(value, update) {
  if (typeof value === 'string') return update(value);
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, update));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, update)]),
  );
}

const stats = computeStats();
const mcpToolCount = TOOL_REGISTRY.length;
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
  capabilities: {
    mcpTools: mcpToolCount,
    locales: stats.locales,
    variants: stats.variantCount,
    mapLayers: stats.layerDefinitions,
    feedDefinitions: stats.feedDefinitions,
    freshnessTrackedSourceGroups: stats.freshnessSources,
  },
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
emit('public/product-facts.json', json(facts));
emit('shared/product-catalog.generated.json', json(catalogBundle));
emit('scripts/shared/product-catalog.generated.json', json(catalogBundle));

const edgeModule = `// AUTO-GENERATED from convex/config/productCatalog.ts and the MCP registry.
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
      block = rewriteStrings(block, (text) => replaceMcpToolCounts(text, mcpToolCount));
      const indented = JSON.stringify(block, null, 2)
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      return `${open}\n${indented}\n    ${close}`;
    },
  );
}

for (const [path, groups] of [
  ['index.html', ['free', 'pro']],
  ['pro-test/welcome.html', ['free', 'pro']],
  ['pro-test/index.html', null],
]) {
  transform(path, (source) => rewriteApplicationJsonLd(source, groups));
}

// Every pro-test locale publishes the MCP tool count (guarded by
// tests/public-product-facts.test.mjs across the full locale sweep), so
// enumerate the directory instead of hand-listing a subset.
const proLocalePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
  .filter((name) => name.endsWith('.json'))
  .map((name) => `pro-test/src/locales/${name}`)
  .sort();

const mcpCountSurfaces = [
  'server.json',
  'cli/README.md',
  ...proLocalePaths,
  'pro-test/prerender.mjs',
  'pro-test/welcome.html',
  'public/pro/welcome.html',
  'blog-site/src/content/blog/ask-claude-whats-happening-worldmonitor-mcp.md',
  'blog-site/src/content/blog/build-geopolitical-risk-agent-worldmonitor-mcp.md',
  'blog-site/src/content/blog/daily-intelligence-briefing-workflow-15-minutes.md',
  'blog-site/src/content/blog/free-vs-paid-real-time-intelligence-dashboards.md',
  'blog-site/src/content/blog/build-on-worldmonitor-developer-api-open-source.md',
  'blog-site/src/content/blog/worldmonitor-mcp-server-ai-agents-real-time-intelligence.md',
  'blog-site/src/content/blog/worldmonitor-is-not-palantir.md',
  'docs/cli.mdx',
  'docs/mcp-overview.mdx',
  'docs/mcp-quickstart.mdx',
  'docs/pricing.mdx',
  'docs/zh/cli.mdx',
  'docs/zh/mcp-overview.mdx',
  'docs/zh/mcp-quickstart.mdx',
  'docs/zh/pricing.mdx',
  'public/agents.md',
  'public/agent.txt',
  'public/ai-search.md',
  'public/developers.md',
  'public/llms.txt',
  'public/llms-full.txt',
  'public/home.md',
  'public/mcp-server.md',
  'public/pricing.md',
  'public/sdks.md',
];
for (const path of mcpCountSurfaces) {
  transform(path, (source) => replaceMcpToolCounts(source, mcpToolCount));
}

// The server card is the machine-readable tool catalog consumed by docs-stats
// and external MCP discovery. Generate it from the same registry as the count
// so adding tools cannot leave a syntactically valid but incomplete card.
transform('public/.well-known/mcp/server-card.json', (source) => {
  const card = JSON.parse(source);
  card.tools = TOOL_REGISTRY.map(({ name, description }) => ({ name, description }));
  return json(card);
});

transform('public/agent-view.json', (source) => {
  const view = JSON.parse(source);
  view.endpoints.mcp.tools = mcpToolCount;
  return json(view);
});

// Every locale publishes the MCP tool count in one stat tile and four
// localized prose claims. The prose phrasings vary per language, so they
// cannot be matched by replaceMcpToolCounts — instead rewrite any 2+ digit
// integer inside exactly these keys (verified: the only other number in any
// locale is a single-digit "1" in ja.json). Guarded by the full-locale sweep
// in tests/public-product-facts.test.mjs.
const LOCALE_TOOL_COUNT_PROSE_KEYS = [
  ['welcome', 'agents', 'b1'],
  ['welcome', 'agents', 'promise'],
  ['welcome', 'pricing', 'proF4'],
  ['welcome', 'faq', 'a7'],
];
for (const path of proLocalePaths) {
  transform(path, (source) => {
    const locale = JSON.parse(source);
    if (typeof locale.welcome?.depth?.s12v === 'string') {
      locale.welcome.depth.s12v = String(mcpToolCount);
    }
    for (const keys of LOCALE_TOOL_COUNT_PROSE_KEYS) {
      let node = locale;
      for (const key of keys.slice(0, -1)) node = node?.[key];
      const leaf = keys[keys.length - 1];
      if (node && typeof node[leaf] === 'string') {
        node[leaf] = node[leaf].replace(/\b\d{2,}\b/g, String(mcpToolCount));
      }
    }
    return json(locale);
  });
}

// The translation baseline records the English string each committed
// translation was made from. A tool-count bump is a pure numeral
// substitution already applied to EVERY locale above, so the baseline gets
// the same substitution — otherwise every count change would report the five
// count-bearing keys as drifted and demand a full LLM translation pass for a
// number. Guarded by tests/pro-locale-freshness.test.mjs.
transform('scripts/locale-baselines/pro-test.json', (source) => {
  const baseline = JSON.parse(source);
  if (typeof baseline['welcome.depth.s12v'] === 'string') {
    baseline['welcome.depth.s12v'] = String(mcpToolCount);
  }
  for (const keys of LOCALE_TOOL_COUNT_PROSE_KEYS) {
    const flatKey = keys.join('.');
    if (typeof baseline[flatKey] === 'string') {
      baseline[flatKey] = baseline[flatKey].replace(/\b\d{2,}\b/g, String(mcpToolCount));
    }
  }
  return json(baseline);
});

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
        features: [`${stats.layerDefinitions} map layers`, '500+ feeds', 'country briefs', 'chokepoints', 'instability scores', 'watchlists', '3 dashboard tabs'],
      },
      {
        name: 'Pro',
        price_usd_monthly: byKey.pro_monthly.price,
        price_usd_yearly: byKey.pro_annual.price,
        features: ['WM Analyst', 'Scenario Engine', 'Route Explorer', 'AI digest', 'custom widget builder', 'MCP', '10 custom dashboards', 'personal license'],
      },
      {
        name: 'Pro Business',
        price_usd_monthly: byKey.pro_business_monthly.price,
        price_usd_yearly: byKey.pro_business_annual.price,
        features: ['Everything in Pro', 'commercial license', 'data export — CSV, JSON & PDF reports', '25 custom dashboards', '250 MCP calls/day', 'priority support'],
      },
      {
        name: 'API',
        price_usd_monthly: byKey.api_starter.price,
        price_usd_yearly: byKey.api_starter_annual.price,
        features: ['REST API', 'license / API key included', '1,000 requests/day starter limit', 'webhooks', 'structured JSON', 'OpenAPI docs', 'commercial license — for your organization'],
      },
      {
        name: 'API Business',
        price_usd_monthly: byKey.api_business.price,
        price_usd_yearly: byKey.api_business_annual.price,
        features: ['Everything in API Starter', '300 requests/minute', '10,000 requests/day', '5 Pro licenses included', 'same company email required', 'commercial license — for your customers', 'priority support'],
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
