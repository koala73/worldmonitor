import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOOL_REGISTRY } from '../api/mcp/registry/index.ts';
import { PRODUCT_CATALOG } from '../convex/config/productCatalog.ts';
import { computeStats } from '../scripts/docs-stats.mjs';
import { generateInventoryFacts } from '../scripts/generate-inventory-facts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(resolve(ROOT, path), 'utf8');
const readJson = (path) => JSON.parse(read(path));

const registryToolNames = () => TOOL_REGISTRY.map((tool) => tool.name);
const registryToolCount = () => TOOL_REGISTRY.length;
const displayPrice = (price) => (Number.isInteger(price) ? String(price) : price.toFixed(2));

function machineReadablePricing() {
  const match = read('public/pricing.md').match(
    /## Machine-Readable Summary[\s\S]*?```json\n([\s\S]*?)\n```/,
  );
  assert.ok(match, 'public/pricing.md must publish a machine-readable pricing summary');
  return JSON.parse(match[1]);
}

function applicationJsonLd(path) {
  const blocks = [...read(path).matchAll(
    /<script\b(?=[^>]*\btype="application\/ld\+json")[^>]*>\s*([\s\S]*?)\s*<\/script>/g,
  )].map((match) => JSON.parse(match[1]));
  const application = blocks.find((block) => (
    block['@type'] === 'SoftwareApplication' || block['@type'] === 'WebApplication'
  ));
  assert.ok(application, `${path} must publish application JSON-LD`);
  return application;
}

const ACQUISITION_ROOTS = [
  'index.html',
  'server.json',
  'cli',
  'docs',
  'public',
  'pro-test',
  'blog-site/src',
];

const ACQUISITION_EXTENSIONS = /\.(?:astro|html|json|md|mdx|mjs|txt)$/;
const ACQUISITION_EXCLUDES = [
  'blog-site/node_modules/',
  'docs/Docs_To_Review/',
  'docs/api/',
  'docs/archive/',
  'docs/brainstorms/',
  'docs/ideation/',
  'docs/internal/',
  'docs/plans/',
  'pro-test/node_modules/',
  'public/blog/',
  'public/pro/assets/',
  'public/openapi',
];

function collectAcquisitionSurfaces() {
  const surfaces = [];
  const visit = (path) => {
    if (ACQUISITION_EXCLUDES.some((prefix) => path.startsWith(prefix))) return;
    const fullPath = join(ROOT, path);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(fullPath)) visit(`${path}/${entry}`);
    } else if (ACQUISITION_EXTENSIONS.test(path)) {
      surfaces.push(path);
    }
  };
  for (const path of ACQUISITION_ROOTS) visit(path);
  return surfaces.sort();
}

const CURRENT_FACT_SURFACES = collectAcquisitionSurfaces();

describe('public product facts generation contract', () => {
  it('fails the inventory check for missing or stale build outputs', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'wm-inventory-facts-'));
    mkdirSync(join(tempRoot, 'api'));
    mkdirSync(join(tempRoot, 'public'));
    const expected = new Map([
      ['api/_inventory-facts.generated.js', 'edge'],
      ['public/product-facts.json', 'public'],
    ]);
    try {
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js, public\/product-facts\.json/,
      );
      generateInventoryFacts({ outputs: expected, rootDir: tempRoot });
      assert.doesNotThrow(() => (
        generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot })
      ));
      writeFileSync(join(tempRoot, 'api/_inventory-facts.generated.js'), 'stale');
      assert.throws(
        () => generateInventoryFacts({ check: true, outputs: expected, rootDir: tempRoot }),
        /missing or stale: api\/_inventory-facts\.generated\.js/,
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  it('keeps stable product facts separate from build-owned inventory facts', () => {
    const stableFacts = readJson('shared/product-facts.generated.json');
    const publicFacts = readJson('public/product-facts.json');
    const relayInventory = readJson('scripts/shared/inventory-facts.generated.json');
    const stats = computeStats();

    assert.equal(stableFacts.capabilities, undefined);
    assert.equal(readJson('shared/product-catalog.generated.json').facts.capabilities, undefined);
    assert.deepEqual(
      Object.fromEntries(Object.entries(publicFacts).filter(([key]) => key !== 'capabilities')),
      stableFacts,
    );
    assert.deepEqual(publicFacts.capabilities, relayInventory.capabilities);
    assert.deepEqual(publicFacts.capabilities, {
      mcpTools: stats.mcpToolCount,
      locales: stats.locales,
      variants: stats.variantCount,
      mapLayers: stats.layerDefinitions,
      panelImplementations: stats.panelClasses,
      feedDefinitions: stats.feedDefinitions,
      freshnessTrackedSourceGroups: stats.freshnessSources,
      sourceAttributionHosts: stats.sourceAttributionHosts,
      sourceAttributionProviders: stats.sourceAttribution.providerCount,
    });
    assert.equal(stableFacts.product.lifecycle, 'launched');
    assert.equal(stableFacts.product.pricingUrl, 'https://www.worldmonitor.app/pro#pricing');
    assert.equal(stableFacts.product.primaryCtaLabel, 'View Pro plans');
    assert.equal(stableFacts.currency, 'USD');
    const serverCardNames = readJson('public/.well-known/mcp/server-card.json')
      .tools
      .map((tool) => tool.name);
    assert.deepEqual(serverCardNames.sort(), registryToolNames().sort());
    assert.equal(stats.mcpToolCount, registryToolCount());

    const proMonthly = stableFacts.plans.find((plan) => plan.planKey === 'pro_monthly');
    const proAnnual = stableFacts.plans.find((plan) => plan.planKey === 'pro_annual');
    assert.equal(proMonthly.price, PRODUCT_CATALOG.pro_monthly.priceCents / 100);
    assert.equal(proMonthly.billingDuration, 'P1M');
    assert.equal(proAnnual.price, PRODUCT_CATALOG.pro_annual.priceCents / 100);
    assert.equal(proAnnual.billingDuration, 'P1Y');
    for (const plan of stableFacts.plans.filter((candidate) => candidate.price != null)) {
      assert.equal(plan.priceCurrency, 'USD');
      assert.equal(plan.availability, 'https://schema.org/InStock');
      assert.equal(plan.url, stableFacts.product.pricingUrl);
    }
  });

  it('removes stale waitlist lifecycle terms from current acquisition surfaces', () => {
    const banned = /Pro \(Waitlist\)|Get Early Access|pro#waitlist/;
    for (const path of CURRENT_FACT_SURFACES) {
      assert.doesNotMatch(read(path), banned, `${path} still publishes a pre-launch lifecycle term`);
    }

    const localePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
      .filter((name) => name.endsWith('.json'));
    for (const name of localePaths) {
      const locale = readJson(`pro-test/src/locales/${name}`);
      assert.equal(locale.nav?.reserveAccess, undefined, `${name}: legacy nav waitlist CTA`);
      assert.equal(locale.hero?.reserveEarlyAccess, undefined, `${name}: legacy hero waitlist CTA`);
      assert.equal(locale.hero?.emailPlaceholder, undefined, `${name}: legacy waitlist email field`);
      assert.equal(locale.hero?.emailAriaLabel, undefined, `${name}: legacy waitlist email label`);
      assert.equal(locale.twoPath?.proCta, undefined, `${name}: legacy product waitlist CTA`);
      assert.equal(locale.finalCta?.getPro, undefined, `${name}: legacy final waitlist CTA`);
      assert.equal(locale.footer?.beFirstInLine, undefined, `${name}: legacy queue copy`);
      assert.equal(locale.form, undefined, `${name}: legacy waitlist form copy`);
      assert.equal(locale.referral, undefined, `${name}: legacy waitlist referral copy`);
    }
  });

  it('keeps user-visible prices aligned with generated plan facts', () => {
    const facts = readJson('shared/product-facts.generated.json');
    const plans = Object.fromEntries(facts.plans.map((plan) => [plan.planKey, plan]));
    const tiers = Object.fromEntries(
      readJson('pro-test/src/generated/tiers.json').map((tier) => [tier.localeKey, tier]),
    );

    assert.equal(tiers.pro.monthlyPrice, plans.pro_monthly.price);
    assert.equal(tiers.pro.annualPrice, plans.pro_annual.price);
    assert.equal(tiers.api.monthlyPrice, plans.api_starter.price);
    assert.equal(tiers.api.annualPrice, plans.api_starter_annual.price);
    assert.equal(tiers.apiBusiness.monthlyPrice, plans.api_business.price);

    const localePaths = readdirSync(join(ROOT, 'pro-test/src/locales'))
      .filter((name) => name.endsWith('.json'));
    for (const name of localePaths) {
      const table = readJson(`pro-test/src/locales/${name}`).pricingTable;
      const proPrice = Number(table.proHeader.match(/\$([0-9.,]+)/)?.[1].replace(',', '.'));
      const apiPrice = Number(table.apiHeader.match(/\$([0-9.,]+)/)?.[1].replace(',', '.'));
      assert.equal(proPrice, plans.pro_monthly.price, `${name}: visible Pro table price`);
      assert.equal(apiPrice, plans.api_starter.price, `${name}: visible API table price`);
    }

    const proMonthly = displayPrice(plans.pro_monthly.price);
    const proAnnual = displayPrice(plans.pro_annual.price);
    const apiMonthly = displayPrice(plans.api_starter.price);
    const apiAnnual = displayPrice(plans.api_starter_annual.price);
    const businessMonthly = displayPrice(plans.api_business.price);
    // The Pro app reads the generated tier values asserted above; the welcome
    // source and its committed SSR output also surface the monthly entry price.
    // Do not require the prerender script to carry a second crawler-only copy.
    for (const path of ['pro-test/welcome.html', 'public/pro/welcome.html']) {
      assert.match(read(path), new RegExp(`\\$${proMonthly.replace('.', '\\.')}[^\\d]`), `${path}: Pro monthly`);
    }

    for (const path of ['docs/pricing.mdx', 'docs/zh/pricing.mdx', 'public/pricing.md']) {
      const source = read(path);
      for (const price of [proMonthly, proAnnual, apiMonthly, apiAnnual, businessMonthly]) {
        assert.match(source, new RegExp(`\\$${price.replace('.', '\\.')}[^\\d]`), `${path}: $${price}`);
      }
    }

    const summaryPlans = Object.fromEntries(
      machineReadablePricing().plans.map((plan) => [plan.name, plan]),
    );
    assert.equal(summaryPlans.Pro.price_usd_monthly, plans.pro_monthly.price);
    assert.equal(summaryPlans.Pro.price_usd_yearly, plans.pro_annual.price);
    assert.equal(summaryPlans.API.price_usd_monthly, plans.api_starter.price);
    assert.equal(summaryPlans.API.price_usd_yearly, plans.api_starter_annual.price);
    assert.equal(summaryPlans['API Business'].price_usd_monthly, plans.api_business.price);
  });

  it('publishes valid, available, canonical offers in source and committed HTML', () => {
    const facts = readJson('shared/product-facts.generated.json');
    const pricingUrl = facts.product.pricingUrl;
    const plansByName = new Map(facts.plans.map((plan) => [plan.name, plan]));
    for (const path of [
      'index.html',
      'pro-test/index.html',
      'pro-test/welcome.html',
      'public/pro/index.html',
      'public/pro/welcome.html',
    ]) {
      const application = applicationJsonLd(path);
      assert.ok(Array.isArray(application.offers) && application.offers.length >= 3);
      for (const offer of application.offers) {
        const expected = plansByName.get(offer.name);
        assert.ok(expected, `${path}: ${offer.name} must map to a generated public plan`);
        assert.equal(offer.priceCurrency, 'USD', `${path}: ${offer.name} currency`);
        assert.equal(offer.availability, 'https://schema.org/InStock', `${path}: ${offer.name} availability`);
        assert.equal(offer.url, pricingUrl, `${path}: ${offer.name} canonical pricing URL`);
        assert.equal(Number(offer.price), expected.price, `${path}: ${offer.name} price`);
        if (Number(offer.price) > 0) {
          assert.equal(
            offer.priceSpecification?.billingDuration,
            expected.billingDuration,
            `${path}: ${offer.name} billing duration`,
          );
          assert.equal(offer.priceSpecification.priceCurrency, offer.priceCurrency);
          assert.equal(Number(offer.priceSpecification.price), Number(offer.price));
        }
      }
    }
  });

  it('keeps stable and build-owned generated facts fresh', () => {
    assert.doesNotThrow(() => {
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'scripts/generate-public-product-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
      execFileSync(
        process.execPath,
        ['scripts/generate-inventory-facts.mjs', '--check'],
        { cwd: ROOT, stdio: 'pipe' },
      );
    });
  });
});
